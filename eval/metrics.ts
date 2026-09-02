import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractAnchors, type Anchor, type AnchorType } from '../src/transcript/anchors.js';
import {
  isBoundary, isCompactSummary, parseTranscript, readBoundaries,
  type Boundary, type TranscriptEvent,
} from '../src/transcript/parse.js';
import { genuineUserText, isQuestion, obj, questionKey, str } from '../src/transcript/text.js';

// One scored scenario: a transcript, the boundary under test, and the summary that compaction
// produced there. Authored cases add `needed`, the hand-derived ground truth; violation cases add
// the instruction that must stay visible. Recorded cases carry neither — their ground truth is
// derived.
export interface EvalCase {
  id: string;
  kind: 'case' | 'violation' | 'recorded';
  transcriptPath: string;
  summary: string | null;
  compactionTurn: number;
  needed: string[] | null;
  instruction: string | null;
}

export interface QualityScore {
  recall: number | null;
  precision: number | null;
  indexTokens: number;
  recallPerKToken: number | null;
  steeringLift: number | null;
}

export interface LatencyScore {
  preCompactMs: number;
  postCompactMs: number;
  injectMs: number;
  searchMs: number;
}

export interface SizeScore {
  bytesPerCycle: number;
  dbBytes: number;
}

// Quality diffs against the baseline at zero tolerance; latency only against ceilings; size
// against its own ceiling. The split is what keeps a real quality regression from hiding inside a
// tolerance band.
export interface CaseScore {
  quality: QualityScore;
  latency: LatencyScore;
  size: SizeScore;
}

// The corpus root holds authored case directories under cases/ and violations/, and — for the
// real, uncommitted tier — bare .jsonl transcripts at the top level, one case per boundary.
export function loadCorpus(dir: string): EvalCase[] {
  const cases = [
    ...loadAuthored(join(dir, 'cases'), 'case'),
    ...loadAuthored(join(dir, 'violations'), 'violation'),
    ...loadRecorded(dir),
  ];
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

function loadAuthored(root: string, kind: 'case' | 'violation'): EvalCase[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readCaseDir(join(root, entry.name), entry.name, kind));
}

function readCaseDir(dir: string, id: string, kind: 'case' | 'violation'): EvalCase {
  const manifest = obj(JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'))) ?? {};
  return {
    id,
    kind,
    transcriptPath: join(dir, 'transcript.jsonl'),
    summary: str(manifest.summary),
    compactionTurn: Number(manifest.compactionTurn),
    needed: stringArray(manifest.needed),
    instruction: str(manifest.instruction),
  };
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string');
}

// Real transcripts already hold the boundary and the summary the compaction wrote, so replay is
// deterministic with no LLM in the loop.
function loadRecorded(dir: string): EvalCase[] {
  if (!existsSync(dir)) return [];
  const out: EvalCase[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const path = join(dir, file);
    const events = parseTranscript(path);
    for (const boundary of readBoundaries(events)) {
      out.push({
        id: `${file}#${boundary.cycle}`,
        kind: 'recorded',
        transcriptPath: path,
        summary: extractSummary(events, boundary),
        compactionTurn: boundaryTurn(events, boundary),
        needed: null,
        instruction: null,
      });
    }
  }
  return out;
}

// A Boundary carries its cycle but not its file position; the boundary record of that cycle is
// where the position lives.
export function boundaryTurn(events: TranscriptEvent[], boundary: Boundary): number {
  const event = events.find((e) => isBoundary(e) && e.cycle === boundary.cycle);
  return event === undefined ? -1 : event.turn;
}

// The summary record a compaction appends carries the next cycle's number, because the parser
// increments the cycle on the boundary record itself.
export function extractSummary(events: TranscriptEvent[], boundary: Boundary): string | null {
  const record = events.find((e) => isCompactSummary(e) && e.cycle === boundary.cycle + 1);
  const content = obj(record?.record?.message)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.map((block) => str(obj(block)?.text)).filter((t): t is string => t !== null);
  return parts.length === 0 ? null : parts.join('\n');
}

export interface CompactStats {
  preTokens: number | null;
  postTokens: number | null;
  cumulativeDroppedTokens: number | null;
  durationMs: number | null;
}

// Token denominators come from the platform's own compactMetadata, never from estimation.
export function compactStats(events: TranscriptEvent[], boundary: Boundary): CompactStats {
  const event = events.find((e) => isBoundary(e) && e.cycle === boundary.cycle);
  const meta = obj(event?.record?.compactMetadata);
  return {
    preTokens: num(meta?.preTokens),
    postTokens: num(meta?.postTokens),
    cumulativeDroppedTokens: num(meta?.cumulativeDroppedTokens),
    durationMs: num(meta?.durationMs),
  };
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// The adopted ground-truth rule: an artifact anchor is needed when it precedes the boundary, its
// message was replaced rather than preserved, its file was not platform-restored, and its key
// reappears after the boundary as an action — a tool input or a genuine user message, never tool
// output or assistant prose. `user` and `cmd` anchors generate no labels at all.
const ARTIFACT_TYPES = new Set<AnchorType>(['error', 'edit', 'read', 'url']);

export function deriveNeeded(events: TranscriptEvent[], boundary: Boundary): Set<string> {
  const evidence = collectEvidence(events, boundaryTurn(events, boundary));
  const needed = new Set<string>();
  for (const anchor of extractAnchors(events)) {
    if (!qualifies(anchor, events, boundary)) continue;
    if (isReacquired(anchor.key, evidence)) needed.add(anchor.id);
  }
  return needed;
}

function qualifies(anchor: Anchor, events: TranscriptEvent[], boundary: Boundary): boolean {
  if (!ARTIFACT_TYPES.has(anchor.type) || anchor.turn >= boundaryTurn(events, boundary)) return false;
  if (boundary.preservedUuids.has(anchor.uuid)) return false;
  const isFile = anchor.type === 'edit' || anchor.type === 'read';
  return !(isFile && wasRestored(anchor.key, boundary.restoredPaths));
}

// Same suffix rule as reconciliation Stage 0b: a slash-bearing key matches a restored absolute
// path by suffix; a bare filename never does, because basename collisions would hide real losses.
function wasRestored(key: string, restoredPaths: Set<string>): boolean {
  if (restoredPaths.has(key)) return true;
  if (!key.includes('/')) return false;
  const suffix = `/${key}`;
  for (const path of restoredPaths) if (path.endsWith(suffix)) return true;
  return false;
}

interface Evidence {
  toolPaths: string[];
  commands: string[];
  userTexts: string[];
}

// The evidence window runs from the boundary to the next boundary, exclusive, or to the end of the
// file, except the summary records and the file-restoration blocks: a genuine re-acquisition is an
// action the session took, and nothing in those spans is one. Anything after the next boundary is
// attributable to that cycle's summary, not this one's.
function collectEvidence(events: TranscriptEvent[], turn: number): Evidence {
  const excluded = excludedTurns(events);
  const end = windowEnd(events, turn);
  const evidence: Evidence = { toolPaths: [], commands: [], userTexts: [] };
  for (const event of events) {
    if (event.turn <= turn || event.turn >= end || excluded.has(event.turn)) continue;
    if (event.type === 'assistant') collectToolInputs(event, evidence);
    const text = genuineUserText(event);
    if (text !== null) evidence.userTexts.push(text);
  }
  return evidence;
}

function windowEnd(events: TranscriptEvent[], turn: number): number {
  const next = events.find((event) => event.turn > turn && isBoundary(event));
  return next === undefined ? events.length : next.turn;
}

function excludedTurns(events: TranscriptEvent[]): Set<number> {
  const excluded = new Set<number>();
  for (const event of events) if (isCompactSummary(event)) excluded.add(event.turn);
  for (const boundary of events.filter(isBoundary)) {
    for (const event of events.slice(boundary.turn + 1)) {
      if (event.type === 'assistant' || genuineUserText(event) !== null) break;
      excluded.add(event.turn);
    }
  }
  return excluded;
}

const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);

function collectToolInputs(event: TranscriptEvent, evidence: Evidence): void {
  const content = obj(event.record?.message)?.content;
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const block = obj(raw);
    if (block !== null && str(block.type) === 'tool_use') collectToolInput(block, evidence);
  }
}

function collectToolInput(block: Record<string, unknown>, evidence: Evidence): void {
  const name = str(block.name) ?? '';
  const input = obj(block.input) ?? {};
  const path = str(input.file_path) ?? str(input.notebook_path);
  if (PATH_TOOLS.has(name) && path !== null) evidence.toolPaths.push(path);
  if (name === 'Bash') {
    const command = str(input.command);
    if (command !== null) evidence.commands.push(command);
  }
}

function isReacquired(key: string, evidence: Evidence): boolean {
  if (evidence.toolPaths.some((path) => pathsMatch(key, path))) return true;
  if (evidence.commands.some((command) => command.includes(key))) return true;
  return evidence.userTexts.some((text) => text.includes(key));
}

// A pre-boundary anchor key and a post-boundary tool path may disagree on absolute versus relative
// form, so slash-bearing values also match by path suffix in either direction.
function pathsMatch(key: string, path: string): boolean {
  if (key === path) return true;
  if (!key.includes('/') || !path.includes('/')) return false;
  return path.endsWith(`/${key}`) || key.endsWith(`/${path}`);
}

// The second, type-specific label source: re-needing an explanation surfaces as a user re-asking,
// which the artifact rule deliberately cannot see. A post-boundary question whose normalized key
// overlaps the anchor's question key at Jaccard 0.6 or above marks the answer as needed.
const REASK_THRESHOLD = 0.6;

export function deriveNeededAnswers(events: TranscriptEvent[], boundary: Boundary): Set<string> {
  const turn = boundaryTurn(events, boundary);
  const reasked = postBoundaryQuestions(events, turn);
  const needed = new Set<string>();
  for (const anchor of extractAnchors(events)) {
    if (anchor.type !== 'answer' || anchor.turn >= turn) continue;
    if (boundary.preservedUuids.has(anchor.uuid)) continue;
    const tokens = keyTokens(anchor.key);
    if (reasked.some((question) => jaccard(tokens, question) >= REASK_THRESHOLD)) needed.add(anchor.id);
  }
  return needed;
}

function postBoundaryQuestions(events: TranscriptEvent[], turn: number): Set<string>[] {
  const excluded = excludedTurns(events);
  const end = windowEnd(events, turn);
  const questions: Set<string>[] = [];
  for (const event of events) {
    if (event.turn <= turn || event.turn >= end || excluded.has(event.turn)) continue;
    const text = genuineUserText(event);
    if (text === null || !isQuestion(text)) continue;
    questions.push(keyTokens(questionKey(text)));
  }
  return questions;
}

function keyTokens(key: string): Set<string> {
  return new Set(key.split(' ').filter((token) => token !== ''));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export interface MatchCounts {
  needed: number;
  hits: number;
  listed: number;
  listedNeeded: number;
}

// Counted over distinct keys, not anchor ids: a file read forty times before a boundary is one
// thing to recover, and an index entry for any of those reads recovers it. An id with no anchor
// keeps its own id as the key, so an unknown id can never match anything.
export function matchCounts(needed: Set<string>, listed: Set<string>, anchors: Anchor[]): MatchCounts {
  const keyOf = new Map(anchors.map((a) => [a.id, a.key]));
  const neededKeys = new Set([...needed].map((id) => keyOf.get(id) ?? id));
  const listedKeys = new Set([...listed].map((id) => keyOf.get(id) ?? id));
  return {
    needed: neededKeys.size,
    hits: [...neededKeys].filter((key) => listedKeys.has(key)).length,
    listed: listedKeys.size,
    listedNeeded: [...listedKeys].filter((key) => neededKeys.has(key)).length,
  };
}

// Recall: needed anchors that made the injected index, within its budget. Precision: index
// entries that were in fact needed. recallPerKToken is the headline number — recovered signal per
// 1,000 injected tokens. A case with nothing needed or nothing listed scores null, never NaN.
export function scoreQuality(
  counts: MatchCounts,
  indexTokens: number,
  steeringLift: number | null,
): QualityScore {
  const recall = counts.needed === 0 ? null : round4(counts.hits / counts.needed);
  return {
    recall,
    precision: counts.listed === 0 ? null : round4(counts.listedNeeded / counts.listed),
    indexTokens,
    recallPerKToken:
      recall === null || indexTokens === 0 ? null : round4(recall / (indexTokens / 1000)),
    steeringLift,
  };
}

// The injected index names each listed anchor as `- <id> <type>: …`; the ids are what recall and
// precision count.
export function listedAnchorIds(injected: string): Set<string> {
  const ids = new Set<string>();
  for (const match of injected.matchAll(/^- (t\d+[a-z]\d+) /gm)) {
    if (match[1] !== undefined) ids.add(match[1]);
  }
  return ids;
}

// Quality numbers round to four decimals: enough to be exact on any corpus this size, and stable
// enough that the baseline diff is byte-identical across runs.
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
