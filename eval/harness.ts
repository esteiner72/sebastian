import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { postCompact } from '../src/hooks/postCompact.js';
import { preCompact } from '../src/hooks/preCompact.js';
import { sessionStart } from '../src/hooks/sessionStart.js';
import { archiveDelta, openDbAt, searchAnchors } from '../src/store/db.js';
import { extractAnchors, type Anchor } from '../src/transcript/anchors.js';
import {
  parseTranscript, readBoundaries, toEvent, type Boundary, type TranscriptEvent,
} from '../src/transcript/parse.js';
import { contentTokens, estimateTokens, obj, str } from '../src/transcript/text.js';
import {
  boundaryTurn, compactStats, deriveNeeded, deriveNeededAnswers, extractSummary,
  listedAnchorIds, loadCorpus, matchCounts, round4, scoreQuality,
  type CaseScore, type EvalCase, type MatchCounts, type QualityScore,
} from './metrics.js';

interface CycleRun {
  cycle: number;
  turn: number;
  boundary: Boundary;
  preMs: number;
  postMs: number;
  startMs: number;
  injected: string;
  retention: number | null;
}

interface CaseResult {
  id: string;
  kind: EvalCase['kind'];
  score: CaseScore;
  counts: MatchCounts;
  samples: { preMs: number[]; startMs: number[]; searchMs: number[]; indexTokens: number[] };
  violationPass: boolean | null;
  derivationDiff: { missing: string[]; extra: string[] } | null;
  hookCostPct: number | null;
  droppedTokens: number | null;
}

export function scoreCase(c: EvalCase): CaseScore {
  return runCase(c).score;
}

export function runEval(corpusDir: string): { perCase: CaseResult[]; aggregate: QualityScore } {
  const perCase = loadCorpus(corpusDir).map(runCase);
  return { perCase, aggregate: aggregateQuality(perCase) };
}

export function runCase(c: EvalCase): CaseResult {
  const tmp = mkdtempSync(join(tmpdir(), 'seb-eval-'));
  try {
    return scoreInDir(tmp, c);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scoreInDir(tmp: string, c: EvalCase): CaseResult {
  const dbFile = join(tmp, 'eval.db');
  const db = openDbAt(dbFile);
  const events = parseTranscript(c.transcriptPath);
  const cycles = replayCycles(db, tmp, c, events);
  const target = cycles.find((cycle) => cycle.turn === c.compactionTurn);
  if (target === undefined) {
    throw new Error(`${c.id}: no compact boundary at turn ${String(c.compactionTurn)}`);
  }
  const result = assemble(db, c, events, cycles, target);
  db.close();
  const dbBytes = statSync(dbFile).size;
  result.score.size = { bytesPerCycle: Math.round(dbBytes / cycles.length), dbBytes };
  return result;
}

// Replays every compaction up to the case's boundary in one database, in order, so cycle N+1's
// steering and verdict state comes from cycle N exactly as it does live.
function replayCycles(
  db: DatabaseSync,
  tmp: string,
  c: EvalCase,
  events: TranscriptEvent[],
): CycleRun[] {
  const lines = events.map((e) => e.raw);
  const sessionId = events.find((e) => e.sessionId !== null)?.sessionId ?? 'eval-session';
  const boundaries = readBoundaries(events).filter((b) => boundaryTurn(events, b) <= c.compactionTurn);
  return boundaries.map((boundary, i) => {
    const turn = boundaryTurn(events, boundary);
    const next = boundaries[i + 1];
    return runCycle({
      db, tmp, sessionId, boundary, turn,
      summary: turn === c.compactionTurn ? c.summary : extractSummary(events, boundary),
      preLines: lines.slice(0, turn),
      postLines: lines.slice(0, next === undefined ? lines.length : boundaryTurn(events, next)),
    });
  });
}

interface CycleInput {
  db: DatabaseSync;
  tmp: string;
  sessionId: string;
  boundary: Boundary;
  turn: number;
  summary: string | null;
  preLines: string[];
  postLines: string[];
}

// One compaction, driven through the real hook bodies with the transcript truncated to what each
// hook would have seen: PreCompact the pre-boundary file, PostCompact the file through the
// boundary and its summary, SessionStart the injection into the fresh window.
function runCycle(input: CycleInput): CycleRun {
  const prePath = join(input.tmp, `pre-${String(input.boundary.cycle)}.jsonl`);
  const postPath = join(input.tmp, `post-${String(input.boundary.cycle)}.jsonl`);
  writeFileSync(prePath, jsonl(input.preLines));
  writeFileSync(postPath, jsonl(input.postLines));
  const t0 = performance.now();
  preCompact(input.db, { transcript_path: prePath, session_id: input.sessionId });
  const t1 = performance.now();
  postCompact(input.db, {
    transcript_path: postPath,
    session_id: input.sessionId,
    compact_summary: input.summary ?? undefined,
    compaction_trigger: input.boundary.trigger ?? undefined,
  });
  const t2 = performance.now();
  const stdout = sessionStart(input.db, { session_id: input.sessionId, source: 'compact' });
  const t3 = performance.now();
  return {
    cycle: input.boundary.cycle,
    turn: input.turn,
    boundary: input.boundary,
    preMs: t1 - t0,
    postMs: t2 - t1,
    startMs: t3 - t2,
    injected: injectedText(stdout),
    retention: identifierRetention(input.db, input.sessionId, input.boundary.cycle),
  };
}

function jsonl(lines: string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function injectedText(stdout: string): string {
  if (stdout.trim() === '') return '';
  const output = obj(obj(JSON.parse(stdout))?.hookSpecificOutput);
  return str(output?.additionalContext) ?? '';
}

function assemble(
  db: DatabaseSync,
  c: EvalCase,
  events: TranscriptEvent[],
  cycles: CycleRun[],
  target: CycleRun,
): CaseResult {
  const derived = union(deriveNeeded(events, target.boundary), deriveNeededAnswers(events, target.boundary));
  const needed = c.needed === null ? derived : new Set(c.needed);
  const listed = listedAnchorIds(target.injected);
  const counts = matchCounts(needed, listed);
  const indexTokens = target.injected === '' ? 0 : estimateTokens(target.injected);
  const searchMs = timeSearches(db, extractAnchors(events), needed);
  const stats = compactStats(events, target.boundary);
  return {
    id: c.id,
    kind: c.kind,
    score: {
      quality: scoreQuality(counts, indexTokens, steeringLift(cycles, target)),
      latency: {
        preCompactMs: round4(target.preMs),
        postCompactMs: round4(target.postMs),
        sessionStartMs: round4(target.startMs),
        searchMs: round4(Math.max(...searchMs)),
      },
      size: { bytesPerCycle: 0, dbBytes: 0 },
    },
    counts,
    samples: {
      preMs: cycles.map((cycle) => cycle.preMs),
      startMs: cycles.map((cycle) => cycle.startMs),
      searchMs,
      indexTokens: cycles.map((cycle) => (cycle.injected === '' ? 0 : estimateTokens(cycle.injected))),
    },
    violationPass: violationPass(db, c, target),
    derivationDiff: derivationDiff(c, derived),
    hookCostPct: stats.durationMs === null || stats.durationMs === 0
      ? null
      : round4((target.preMs / stats.durationMs) * 100),
    droppedTokens: stats.preTokens !== null && stats.postTokens !== null
      ? stats.preTokens - stats.postTokens
      : stats.cumulativeDroppedTokens,
  };
}

function union(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set(a);
  for (const id of b) out.add(id);
  return out;
}

// steeringLift is the change in identifier retention from the previous cycle to the case's cycle;
// a single-boundary case cannot produce one and scores null.
function steeringLift(cycles: CycleRun[], target: CycleRun): number | null {
  const previous = cycles[cycles.indexOf(target) - 1];
  if (previous === undefined || previous.retention === null || target.retention === null) return null;
  return round4(target.retention - previous.retention);
}

function identifierRetention(db: DatabaseSync, sessionId: string, cycle: number): number | null {
  const row = db.prepare(
    "SELECT COUNT(*) AS total, SUM(verdict = 'kept') AS kept FROM anchors " +
      "WHERE session_id = ? AND cycle = ? AND verdict IS NOT NULL AND type IN ('edit', 'read', 'cmd', 'url')",
  ).get(sessionId, cycle);
  const total = Number(row?.total ?? 0);
  return total === 0 ? null : Number(row?.kept ?? 0) / total;
}

// A violation passes when the dropped instruction is visible from the injected index. User anchors
// spend no entry line by design, so visibility means the counts line reports the user drop and the
// dropped anchor row exists for `seb index --dropped` to list. Whether an entry line should be
// required instead is an open corpus question.
function violationPass(db: DatabaseSync, c: EvalCase, target: CycleRun): boolean | null {
  if (c.kind !== 'violation') return null;
  if (c.instruction === null || !/\b\d+ user\b/.test(target.injected)) return false;
  const instruction = c.instruction;
  const rows = db.prepare(
    "SELECT key FROM anchors WHERE cycle = ? AND type = 'user' AND verdict = 'dropped'",
  ).all(target.cycle);
  return rows.some((row) => instruction.includes(String(row.key)));
}

// The authored corpus doubles as the regression test for the derivation rule: any disagreement
// between deriveNeeded and the authored set is a failure, whichever side is longer.
function derivationDiff(
  c: EvalCase,
  derived: Set<string>,
): { missing: string[]; extra: string[] } | null {
  if (c.needed === null) return null;
  const authored = new Set(c.needed);
  return {
    missing: [...authored].filter((id) => !derived.has(id)).sort(),
    extra: [...derived].filter((id) => !authored.has(id)).sort(),
  };
}

// Search latency is measured with the queries a reader would plausibly type: the leading content
// tokens of each needed anchor's key.
function timeSearches(db: DatabaseSync, anchors: Anchor[], needed: Set<string>): number[] {
  const byId = new Map(anchors.map((a) => [a.id, a]));
  const queries = [...needed]
    .map((id) => byId.get(id))
    .filter((a): a is Anchor => a !== undefined)
    .map((a) => contentTokens(a.key).slice(0, 3).join(' '))
    .filter((q) => q !== '');
  if (queries.length === 0) queries.push('sebastian');
  return queries.map((query) => timeMs(() => searchAnchors(db, query)));
}

function timeMs(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

// Search latency at each archive size, on a generated archive. The marker term appears in exactly
// ten anchors regardless of size, so the measurement tracks index navigation, not result volume —
// a regression to a table scan tracks total rows instead and fails the sublinear gate.
export function scaleProfile(anchorCounts: number[]): { count: number; searchMs: number }[] {
  const tmp = mkdtempSync(join(tmpdir(), 'seb-scale-'));
  try {
    const db = openDbAt(join(tmp, 'scale.db'));
    const profile: { count: number; searchMs: number }[] = [];
    let built = 0;
    for (const count of [...anchorCounts].sort((a, b) => a - b)) {
      growArchive(db, built, count);
      built = count;
      profile.push({ count, searchMs: medianSearchMs(db) });
    }
    db.close();
    return profile;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function growArchive(db: DatabaseSync, from: number, to: number): void {
  const events: TranscriptEvent[] = [];
  const anchors: Anchor[] = [];
  for (let i = from; i < to; i += 1) {
    const uuid = `scale-${String(i)}`;
    events.push(toEvent(i, 0, JSON.stringify({ uuid, sessionId: 'scale', type: 'assistant' })));
    const key = i < 10 ? `sebmark needle ${String(i)}` : `src/scale/file-${String(i)}.ts token${String(i % 997)}`;
    anchors.push({ id: `t${String(i)}r1`, uuid, sessionId: 'scale', cycle: 0, turn: i, type: 'read', key, excerpt: key });
  }
  archiveDelta(db, events, anchors);
}

function medianSearchMs(db: DatabaseSync): number {
  const times: number[] = [];
  for (let run = 0; run < 15; run += 1) times.push(timeMs(() => searchAnchors(db, 'sebmark')));
  const sorted = times.sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

// Sublinear gate: growing the archive 100x may cost at most half of 100x the small-archive time.
// The floor keeps a sub-measurable small-archive time from making the allowance impossible.
function scaleFailure(profile: { count: number; searchMs: number }[]): string | null {
  const first = profile[0];
  const last = profile.at(-1);
  if (first === undefined || last === undefined || first === last) return null;
  const allowed = (Math.max(first.searchMs, 0.2) * (last.count / first.count)) / 2;
  if (last.searchMs <= allowed) return null;
  return `scale: search at ${String(last.count)} anchors took ${last.searchMs.toFixed(2)}ms, over the sublinear allowance of ${allowed.toFixed(2)}ms`;
}

function aggregateQuality(perCase: CaseResult[]): QualityScore {
  const totals = perCase.reduce(
    (t, r) => ({
      needed: t.needed + r.counts.needed,
      hits: t.hits + r.counts.hits,
      listed: t.listed + r.counts.listed,
      listedNeeded: t.listedNeeded + r.counts.listedNeeded,
    }),
    { needed: 0, hits: 0, listed: 0, listedNeeded: 0 },
  );
  // The mean per case, never the sum. `recallPerKToken` divides a pooled recall by this, so a
  // summed denominator would shrink the headline number every time a case is added and fail the
  // zero-tolerance baseline for a reason unrelated to quality. The mean also compares directly
  // against the per-injection `indexTokens` budget, which a corpus-wide sum does not.
  const total = perCase.reduce((n, r) => n + r.score.quality.indexTokens, 0);
  const indexTokens = perCase.length === 0 ? 0 : Math.round(total / perCase.length);
  const lifts = perCase
    .map((r) => r.score.quality.steeringLift)
    .filter((lift): lift is number => lift !== null);
  const quality = scoreQuality(totals, indexTokens, null);
  quality.steeringLift = lifts.length === 0
    ? null
    : round4(lifts.reduce((a, b) => a + b, 0) / lifts.length);
  return quality;
}

interface Budgets {
  preCompactMs: { p95: number; max: number };
  sessionStartMs: { p95: number };
  searchMs: { p95: number };
  indexTokens: { max: number };
  bytesPerCycle: { max: number; maxFull: number };
}

// Ceilings, not targets: deliberately loose so runner noise cannot fail a build, hard enough that
// a hung hook or a table scan does. The archive stores raw transcript deltas, so a real session's
// cycle runs to tens of megabytes where a 20-60-record authored case stays under half a megabyte —
// hence the separate bytes ceiling for the full tier.
function budgetFailures(
  perCase: CaseResult[],
  profile: { count: number; searchMs: number }[],
  budgets: Budgets,
  full: boolean,
): string[] {
  const pre = perCase.flatMap((r) => r.samples.preMs);
  const start = perCase.flatMap((r) => r.samples.startMs);
  const search = [...perCase.flatMap((r) => r.samples.searchMs), ...profile.map((p) => p.searchMs)];
  const tokens = perCase.flatMap((r) => r.samples.indexTokens);
  const bytes = perCase.map((r) => r.score.size.bytesPerCycle);
  const failures: string[] = [];
  checkCeiling(failures, 'preCompactMs p95', p95(pre), budgets.preCompactMs.p95);
  checkCeiling(failures, 'preCompactMs max', max(pre), budgets.preCompactMs.max);
  checkCeiling(failures, 'sessionStartMs p95', p95(start), budgets.sessionStartMs.p95);
  checkCeiling(failures, 'searchMs p95', p95(search), budgets.searchMs.p95);
  checkCeiling(failures, 'indexTokens max', max(tokens), budgets.indexTokens.max);
  const bytesCeiling = full ? budgets.bytesPerCycle.maxFull : budgets.bytesPerCycle.max;
  checkCeiling(failures, 'bytesPerCycle max', max(bytes), bytesCeiling);
  return failures;
}

function checkCeiling(failures: string[], name: string, value: number, ceiling: number): void {
  if (value > ceiling) failures.push(`budget: ${name} ${value.toFixed(2)} exceeds ceiling ${String(ceiling)}`);
}

function max(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

const BASELINE_PATH = join('eval', 'baseline.json');
const BUDGETS_PATH = join('eval', 'budgets.json');

interface Snapshot {
  aggregate: QualityScore;
  perCase: Record<string, QualityScore>;
}

function qualitySnapshot(perCase: CaseResult[], aggregate: QualityScore): Snapshot {
  return {
    aggregate,
    perCase: Object.fromEntries(perCase.map((r) => [r.id, r.score.quality])),
  };
}

// Zero tolerance: the stored quality block must match the run's exactly. Regeneration happens only
// through `npm run eval:baseline`, never as a side effect of a failing run.
function baselineFailures(snapshot: Snapshot, write: boolean): string[] {
  if (write) {
    writeBaseline(snapshot);
    return [];
  }
  if (!existsSync(BASELINE_PATH)) {
    return ['baseline: eval/baseline.json is missing; run `npm run eval:baseline` once the corpus is authored'];
  }
  const stored = obj(JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))) ?? {};
  const storedQuality = JSON.stringify({ aggregate: stored.aggregate, perCase: stored.perCase });
  const currentQuality = JSON.stringify(snapshot);
  if (storedQuality === currentQuality) return [];
  return [`baseline: quality diverged\n  stored:  ${storedQuality}\n  current: ${currentQuality}`];
}

function writeBaseline(snapshot: Snapshot): void {
  const body = { generatedAt: new Date().toISOString(), commit: gitCommit(), ...snapshot };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`baseline: wrote ${BASELINE_PATH} at ${body.commit}`);
}

function gitCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function collectFailures(
  perCase: CaseResult[],
  aggregate: QualityScore,
  profile: { count: number; searchMs: number }[],
  opts: { full: boolean; write: boolean },
): string[] {
  const failures: string[] = perCase.flatMap(caseFailures);
  const budgets = JSON.parse(readFileSync(BUDGETS_PATH, 'utf8')) as Budgets;
  failures.push(...budgetFailures(perCase, profile, budgets, opts.full));
  const scale = scaleFailure(profile);
  if (scale !== null) failures.push(scale);
  if (!opts.full && perCase.length > 0) {
    failures.push(...baselineFailures(qualitySnapshot(perCase, aggregate), opts.write));
  }
  return failures;
}

function caseFailures(r: CaseResult): string[] {
  const failures: string[] = [];
  if (r.kind === 'violation' && r.violationPass !== true) {
    failures.push(`violation: ${r.id} — the dropped instruction is not visible from the injected index`);
  }
  const diff = r.derivationDiff;
  if (diff !== null && (diff.missing.length > 0 || diff.extra.length > 0)) {
    failures.push(
      `derivation: ${r.id} — deriveNeeded disagrees with the authored set` +
        ` (missing: [${diff.missing.join(', ')}]; extra: [${diff.extra.join(', ')}])`,
    );
  }
  return failures;
}

function printReport(
  perCase: CaseResult[],
  aggregate: QualityScore,
  profile: { count: number; searchMs: number }[],
  failures: string[],
): void {
  for (const r of perCase) console.log(caseLine(r));
  console.log(
    `aggregate over ${String(perCase.length)} case(s): recall=${fmt(aggregate.recall)}` +
      ` precision=${fmt(aggregate.precision)} meanIndexTokens=${String(aggregate.indexTokens)}` +
      ` recallPerKToken=${fmt(aggregate.recallPerKToken)} steeringLift=${fmt(aggregate.steeringLift)}`,
  );
  console.log(`scale: ${profile.map((p) => `${String(p.count)} anchors -> ${p.searchMs.toFixed(2)}ms`).join(', ')}`);
  if (perCase.length === 0) console.log('corpus empty: nothing scored; author eval/corpus next.');
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.log(failures.length === 0 ? 'eval: green' : `eval: ${String(failures.length)} failure(s)`);
}

function caseLine(r: CaseResult): string {
  const q = r.score.quality;
  const violation = r.violationPass === null ? '' : ` violation=${r.violationPass ? 'pass' : 'fail'}`;
  const cost = r.hookCostPct === null ? '' : ` hookCost=${String(r.hookCostPct)}%`;
  const dropped = r.droppedTokens === null ? '' : ` droppedTokens=${String(r.droppedTokens)}`;
  return (
    `${r.id} [${r.kind}] recall=${fmt(q.recall)} precision=${fmt(q.precision)}` +
    ` indexTokens=${String(q.indexTokens)} recallPerKToken=${fmt(q.recallPerKToken)}` +
    ` steeringLift=${fmt(q.steeringLift)}${violation}${cost}${dropped}`
  );
}

function fmt(value: number | null): string {
  return value === null ? 'n/a' : String(value);
}

function realCorpusDir(): string {
  return process.env.SEBASTIAN_EVAL_CORPUS ?? join(homedir(), 'sebastian-eval-corpus');
}

function main(): number {
  const flags = new Set(process.argv.slice(2));
  const full = flags.has('--full');
  const corpusDir = full ? realCorpusDir() : join('eval', 'corpus');
  if (full && !existsSync(corpusDir)) {
    console.error(
      `eval:full reads real transcripts from ${corpusDir}, which does not exist. ` +
        'Set SEBASTIAN_EVAL_CORPUS to a directory of recorded session .jsonl files.',
    );
    return 1;
  }
  const { perCase, aggregate } = existsSync(corpusDir)
    ? runEval(corpusDir)
    : { perCase: [], aggregate: aggregateQuality([]) };
  const profile = scaleProfile([1000, 10000, 100000]);
  const failures = collectFailures(perCase, aggregate, profile, {
    full,
    write: flags.has('--write-baseline'),
  });
  printReport(perCase, aggregate, profile, failures);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
