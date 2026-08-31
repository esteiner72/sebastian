import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { latestReconciledCycle, openDb, projectSlug } from '../src/store/db.js';
import { renderForgottenIndex } from '../src/reconcile/render.js';
import { preCompact } from '../src/hooks/preCompact.js';
import { postCompact } from '../src/hooks/postCompact.js';
import { sessionStart } from '../src/hooks/sessionStart.js';
import { runHook } from '../src/hooks/runHook.js';
import { main } from '../src/index.js';

// Every hook runs against a real temporary home: the state database lands under it exactly as it
// does in production, and so does the transcript that the empty-`transcript_path` fallback has to
// find. Nothing here is mocked, and each scenario uses its own cwd, hence its own database.
const HOME = mkdtempSync(join(tmpdir(), 'seb-hooks-home-'));
const REAL_HOME = process.env.HOME;

beforeAll(() => {
  process.env.HOME = HOME;
});

afterAll(() => {
  process.env.HOME = REAL_HOME;
});

const TS = '2026-08-31T12:00:00.000Z';
const SEVEN_TYPES = fileURLToPath(new URL('./fixtures/seven-types.jsonl', import.meta.url));
const STEERING_BASE = fileURLToPath(new URL('./golden/steering-base.txt', import.meta.url));

// A summary about something else entirely: it shares no content token with any anchor in either
// transcript, so every anchor that reaches text matching is ruled dropped at score 0. That is what
// makes the verdict counts below hand-derivable.
const SUMMARY = [
  '1. Primary Request and Intent: Repaint the bicycle shed before Tuesday.',
  '2. Pending Tasks: Buy two litres of white gloss.',
].join('\n');

// A second summary, sharing no content token with the first one or with any anchor, so a verdict
// scored against the wrong one of the two is visible.
const SECOND_SUMMARY = '1. Primary Request and Intent: Rehang the garden gate on Thursday.';

const line = (record: unknown): string => JSON.stringify(record);

const userText = (session: string, uuid: string, text: string): string =>
  line({ type: 'user', uuid, sessionId: session, timestamp: TS, message: { role: 'user', content: text } });

const assistantText = (session: string, uuid: string, text: string): string =>
  line({
    type: 'assistant', uuid, sessionId: session, timestamp: TS,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

const toolResult = (session: string, uuid: string, id: string, body: string): string =>
  line({
    type: 'user', uuid, sessionId: session, timestamp: TS,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body }] },
  });

// The three records Claude Code appends in place at compaction: the boundary carrying the exact
// preserved set, the summary, and the files it restores right after. The summary record does not
// close the restoration window, so the attachment still counts.
const boundaryRecord = (session: string, uuid: string, preserved: string[], trigger = 'manual'): string =>
  line({
    type: 'system', subtype: 'compact_boundary', uuid, sessionId: session, timestamp: TS,
    content: 'Conversation compacted', level: 'info',
    compactMetadata: {
      trigger, preTokens: 418589, postTokens: 20617, cumulativeDroppedTokens: 644449,
      durationMs: 137854,
      preservedSegment: { headUuid: preserved[0], anchorUuid: preserved[0], tailUuid: preserved.at(-1) },
      preservedMessages: { anchorUuid: preserved[0], uuids: preserved, allUuids: preserved },
    },
  });

const summaryRecord = (session: string, uuid: string, text: string): string =>
  line({
    type: 'user', uuid, sessionId: session, timestamp: TS,
    isCompactSummary: true, isVisibleInTranscriptOnly: true,
    message: { role: 'user', content: text },
  });

const restoredRecord = (session: string, uuid: string, path: string): string =>
  line({
    type: 'attachment', uuid, sessionId: session, timestamp: TS,
    attachment: { type: 'compact_file_reference', filename: path },
  });

function transcriptPath(cwd: string, session: string): string {
  const dir = join(HOME, '.claude', 'projects', projectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  return join(dir, `${session}.jsonl`);
}

function writeTranscript(cwd: string, session: string, lines: string[]): string {
  const path = transcriptPath(cwd, session);
  writeFileSync(path, lines.map((l) => `${l}\n`).join(''));
  return path;
}

const payload = (fields: Record<string, unknown>): string => JSON.stringify(fields);

const count = (db: DatabaseSync, sql: string): number => Number(db.prepare(`SELECT COUNT(*) AS n ${sql}`).get()?.n);

const entryLines = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('- t'));

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

function injected(out: string): string {
  const parsed = JSON.parse(out) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
  return parsed.hookSpecificOutput.additionalContext;
}

// One cycle end to end, through the same three entry points hooks/run-hook.sh reaches, with the
// transcript growing in place at compaction the way Claude Code grows it.
describe('the compaction cycle, hook by hook', () => {
  const cwd = join(HOME, 'project-cycle');
  const session = 'fix-seven';

  // seven-types.jsonl yields 9 anchors; the two appended tool results add one error anchor each,
  // both admitted on their `Error:` gate line, for 11 anchors over 11 archivable records.
  const before = [
    ...readFileSync(SEVEN_TYPES, 'utf8').split('\n').filter((l) => l.trim() !== ''),
    toolResult(session, 'u9', 'toolu_b3',
      'Exit code 1\nRangeError: Maximum call stack size exceeded while normalizing the retry backoff window inside the second attempt of the sync loop'),
    toolResult(session, 'u10', 'toolu_b4',
      'Exit code 1\nAssertionError: expected the reconciler to keep every error signature but the store returned an empty verdict list for the replayed cycle'),
  ];

  it('archives the delta and prints steering without recording a cycle, then reconciles, persists verdicts and injects the full index', () => {
    const path = writeTranscript(cwd, session, before);

    // PreCompact. Its stdout is the compact-instruction channel, and an empty database earns no
    // adaptive line, so the block is the base golden byte for byte.
    const steering = runHook('pre-compact', preCompact,
      payload({ session_id: session, transcript_path: path, cwd, hook_event_name: 'PreCompact', trigger: 'manual' }));
    expect(steering).toBe(readFileSync(STEERING_BASE, 'utf8'));

    const db = openDb(projectSlug(cwd));
    expect(count(db, 'FROM messages')).toBe(11);
    expect(count(db, 'FROM anchors')).toBe(11);
    // PreCompact fires before compaction is decided, so it never writes cycle bookkeeping: a
    // refused compaction would otherwise shift every later cycle number.
    expect(count(db, 'FROM cycles')).toBe(0);
    expect(count(db, 'FROM anchors WHERE verdict IS NOT NULL')).toBe(0);
    db.close();

    // Compaction appends to the same file: boundary, summary, restored file. The boundary records
    // the trigger as `auto` and the payload contradicts it, so the row below shows which side the
    // hook believes.
    appendFileSync(path, `${[
      boundaryRecord(session, 'b11', ['u7'], 'auto'),
      summaryRecord(session, 's12', SUMMARY),
      restoredRecord(session, 'at13', '/repo/README.md'),
    ].join('\n')}\n`);

    // PostCompact. Nothing reaches the user, so stdout stays empty. The trigger arrives as
    // `compaction_trigger`, which is the name the hook reference documents; a hook that reads only
    // the `trigger` a live probe recorded silently falls back to the boundary's own value.
    expect(runHook('post-compact', postCompact,
      payload({ session_id: session, transcript_path: path, cwd, hook_event_name: 'PostCompact', compaction_trigger: 'manual', compact_summary: SUMMARY })))
      .toBe('');

    const after = openDb(projectSlug(cwd));
    expect(after.prepare('SELECT cycle, trigger, summary FROM cycles').all()).toEqual([
      { cycle: 0, trigger: 'manual', summary: SUMMARY },
    ]);
    // t7u1 rides the preserved-uuid stage to kept at 1.0 without consulting the summary; the
    // remaining 10 anchors share no token and no identifier with it, so they all drop.
    expect(after.prepare("SELECT id, score FROM anchors WHERE verdict = 'kept'").all())
      .toEqual([{ id: 't7u1', score: 1 }]);
    expect(count(after, "FROM anchors WHERE verdict = 'dropped'")).toBe(10);
    // PostCompact archived the three records compaction appended after PreCompact ran — the
    // boundary, the summary, and the restoration — because on a session's final compaction no
    // later hook would, and they would not outlive transcript cleanup. They yield no anchors.
    expect(count(after, 'FROM messages')).toBe(14);
    expect(count(after, "FROM messages WHERE uuid IN ('b11', 's12', 'at13')")).toBe(3);
    expect(count(after, 'FROM anchors')).toBe(11);
    after.close();

    // SessionStart, matcher compact. Three error anchors dropped earns the full tier, which lists
    // every listable drop: 3 error, 1 answer, 1 edit, 2 read, 1 url. The 2 cmd drops and the kept
    // user anchor never spend an entry.
    const context = injected(runHook('session-start', sessionStart,
      payload({ session_id: session, cwd, hook_event_name: 'SessionStart', source: 'compact' })));
    expect(context.startsWith('## Forgotten Index\n')).toBe(true);
    expect(context).toContain('Dropped this cycle: 3 error, 1 answer, 1 edit, 2 cmd, 2 read, 1 url (11 anchors reconciled).');
    expect(entryLines(context)).toHaveLength(8);
    expect(estimateTokens(context)).toBeLessThanOrEqual(800);
  });
});

// The digest is what a cycle gets when it lost nothing high-priority, and its budget is the only
// thing that bounds it once the entry cap is not binding.
describe('session-start tier selection', () => {
  const cwd = join(HOME, 'project-digest');
  const session = 'fix-digest';

  // Four question-and-answer pairs, so the cycle drops four `answer` anchors and no `error` or
  // `edit` anchor at all. Each reply is long enough that four entries cannot fit the digest
  // budget, which is what makes the arithmetic below hold.
  const pairs: [string, string, string, string][] = [
    ['u1', 'a2', 'Why does the summarizer drop long explanations first?',
      'The summarizer keeps identifiers when the compact instructions name them, and it collapses prose first, so a long session loses explanation before it loses a file path.'],
    ['u3', 'a4', 'How does the reconciler decide that an anchor survived?',
      'An anchor survives when its message stays in context verbatim, or when the platform restores the file it names, and only the rest reach text matching.'],
    ['u5', 'a6', 'What happens when the transcript field arrives empty?',
      'An empty transcript field falls back to the newest file named for the session under the projects directory, and nothing is archived when no such file exists.'],
    ['u7', 'a8', 'When does the digest give way to the full index?',
      'The digest gives way to the full index only when a high-priority anchor was lost, because a fixed spend every cycle can cost more context than it recovers.'],
  ];

  const transcript = [
    ...pairs.flatMap(([q, a, question, answer]) => [
      userText(session, q, question),
      assistantText(session, a, answer),
    ]),
    // Two records that carry no anchor: a one-word thanks has too few content tokens, and its
    // reply answers no pending question. Preserving them keeps the preserved set realistic
    // without keeping an anchor.
    userText(session, 'u9', 'Thanks.'),
    assistantText(session, 'a10', 'Done.'),
    boundaryRecord(session, 'b11', ['u9', 'a10']),
    summaryRecord(session, 's12', SUMMARY),
  ];

  it('bounds the digest by its token budget rather than its entry cap, listing fewer entries than the untruncated index holds', () => {
    const path = writeTranscript(cwd, session, transcript);
    runHook('pre-compact', preCompact, payload({ session_id: session, transcript_path: path, cwd }));
    runHook('post-compact', postCompact,
      payload({ session_id: session, transcript_path: path, cwd, compact_summary: SUMMARY }));

    const context = injected(runHook('session-start', sessionStart,
      payload({ session_id: session, cwd, source: 'compact' })));
    expect(context).toContain('Dropped this cycle: 4 answer (4 anchors reconciled).');

    // The same four entries with no budget pressure exceed the digest budget, and the digest
    // therefore renders fewer of them. Both halves are needed: the first alone would also pass
    // with the entry cap doing the work, and the second alone with any budget at all.
    const db = openDb(projectSlug(cwd));
    const cycle = latestReconciledCycle(db, session);
    const untruncated = renderForgottenIndex(cycle?.verdicts ?? [], cycle?.anchors ?? [], { tier: 'full', budget: 4000 });
    db.close();
    expect(entryLines(untruncated)).toHaveLength(4);
    expect(estimateTokens(untruncated)).toBeGreaterThan(150);
    expect(estimateTokens(context)).toBeLessThanOrEqual(150);
    expect(entryLines(context).length).toBeLessThan(4);
    expect(entryLines(context).length).toBeGreaterThan(0);
  });

  it('emits a one-line availability note for matcher resume, not an index', () => {
    const context = injected(runHook('session-start', sessionStart,
      payload({ session_id: session, cwd, source: 'resume' })));
    expect(context.split('\n')).toHaveLength(1);
    expect(context).toContain('seb search');
  });
});

// The degraded paths. Each one has to end in exit 0 with the database in a state the next cycle
// can still read.
describe('degraded hook payloads', () => {
  it('resolves an empty transcript_path from the session id under the projects directory, and archives nothing when no such file exists', () => {
    const cwd = join(HOME, 'project-nopath');
    const session = 'fix-nopath';
    writeTranscript(cwd, session, readFileSync(SEVEN_TYPES, 'utf8').split('\n').filter((l) => l.trim() !== ''));

    expect(runHook('pre-compact', preCompact, payload({ session_id: session, transcript_path: '', cwd })))
      .toBe(readFileSync(STEERING_BASE, 'utf8'));
    const db = openDb(projectSlug(cwd));
    expect(count(db, 'FROM messages')).toBe(9);

    // No file anywhere for this session id: the archive is skipped, the steering channel is not.
    expect(runHook('pre-compact', preCompact, payload({ session_id: 'no-such-session', transcript_path: '', cwd })))
      .toBe(readFileSync(STEERING_BASE, 'utf8'));
    expect(count(db, 'FROM messages')).toBe(9);
    expect(count(db, "FROM log WHERE level = 'warn'")).toBe(1);
    db.close();
  });

  it('leaves every verdict NULL when neither the payload nor the transcript carries a summary, and injects nothing', () => {
    const cwd = join(HOME, 'project-nosummary');
    const session = 'fix-nosummary';
    const path = writeTranscript(cwd, session, [
      ...readFileSync(SEVEN_TYPES, 'utf8').split('\n').filter((l) => l.trim() !== ''),
      boundaryRecord(session, 'b9', ['u7']),
    ]);

    runHook('pre-compact', preCompact, payload({ session_id: session, transcript_path: path, cwd }));
    expect(runHook('post-compact', postCompact, payload({ session_id: session, transcript_path: path, cwd }))).toBe('');

    const db = openDb(projectSlug(cwd));
    // The cycle happened, so it is recorded — but matching against nothing would rule every
    // anchor dropped at score 0 and poison drop-rate for every later cycle, so no verdict lands
    // and the row stays unstamped.
    expect(db.prepare('SELECT cycle, summary, reconciled_at FROM cycles').all()).toEqual([
      { cycle: 0, summary: null, reconciled_at: null },
    ]);
    expect(count(db, 'FROM anchors WHERE verdict IS NOT NULL')).toBe(0);
    db.close();

    expect(runHook('session-start', sessionStart, payload({ session_id: session, cwd, source: 'compact' }))).toBe('');
  });

  it('cedes precedence to a /compact argument with one appended line, so steering cannot contradict an explicit user instruction', () => {
    const cwd = join(HOME, 'project-custom');
    const out = runHook('pre-compact', preCompact,
      payload({ session_id: 'fix-custom', cwd, custom_instructions: 'focus on the auth work' }));
    expect(out).toBe(`${readFileSync(STEERING_BASE, 'utf8')}- The user's own compact instructions take precedence over the lines above wherever they conflict.\n`);

    // The probe observed custom_instructions: null on a bare /compact — no line for null, and
    // none for whitespace either.
    expect(runHook('pre-compact', preCompact,
      payload({ session_id: 'fix-custom', cwd, custom_instructions: null })))
      .toBe(readFileSync(STEERING_BASE, 'utf8'));
    expect(runHook('pre-compact', preCompact,
      payload({ session_id: 'fix-custom', cwd, custom_instructions: '  ' })))
      .toBe(readFileSync(STEERING_BASE, 'utf8'));
  });

  it('never reconciles a second compaction against the previous cycle\'s summary, and never injects the stale index in its place', () => {
    const cwd = join(HOME, 'project-stale');
    const session = 'fix-stale';
    const path = writeTranscript(cwd, session, [
      userText(session, 'u1', 'Why does the archiver skip crash-torn trailing lines?'),
      assistantText(session, 'a2',
        'A crash-torn trailing line fails to parse, so the archiver skips that one record and keeps every complete earlier line instead of aborting the delta.'),
      boundaryRecord(session, 'b3', ['zz-none']),
      summaryRecord(session, 's4', SUMMARY),
    ]);
    runHook('pre-compact', preCompact, payload({ session_id: session, transcript_path: path, cwd }));
    runHook('post-compact', postCompact,
      payload({ session_id: session, transcript_path: path, cwd, compact_summary: SUMMARY }));

    // The second compaction appends its boundary, but its summary record has not landed and the
    // payload carries none. The only summary in the file is cycle 0's — reconciling against it
    // would persist verdicts scored on the wrong text, silently.
    appendFileSync(path, `${[
      userText(session, 'u5', 'How does the store deduplicate messages archived twice?'),
      assistantText(session, 'a6',
        'The store deduplicates on the message uuid primary key, so a second archive of the same delta inserts zero rows and the counts stay honest.'),
      boundaryRecord(session, 'b7', ['zz-none']),
    ].join('\n')}\n`);
    runHook('pre-compact', preCompact, payload({ session_id: session, transcript_path: path, cwd }));
    runHook('post-compact', postCompact, payload({ session_id: session, transcript_path: path, cwd }));

    const db = openDb(projectSlug(cwd));
    expect(db.prepare('SELECT cycle, summary, reconciled_at FROM cycles WHERE cycle = 1').all()).toEqual([
      { cycle: 1, summary: null, reconciled_at: null },
    ]);
    expect(count(db, 'FROM anchors WHERE cycle = 1 AND verdict IS NOT NULL')).toBe(0);
    db.close();

    // The session's latest cycle is unreconciled, so nothing is injected — not cycle 0's index
    // relabelled as this cycle's.
    expect(runHook('session-start', sessionStart, payload({ session_id: session, cwd, source: 'compact' }))).toBe('');
  });

  it('never injects another session\'s reconciled cycle when this session\'s verdicts are NULL', () => {
    const cwd = join(HOME, 'project-cross');
    const other = 'fix-cross-other';
    const otherPath = writeTranscript(cwd, other, [
      userText(other, 'x1', 'Why does the eslint complexity ceiling sit at twelve?'),
      assistantText(other, 'x2',
        'The ceiling sits at twelve because functions above it stop reading straight through, and readable control flow is the metric this project watches.'),
      boundaryRecord(other, 'xb3', ['zz-none']),
      summaryRecord(other, 'xs4', SUMMARY),
    ]);
    runHook('pre-compact', preCompact, payload({ session_id: other, transcript_path: otherPath, cwd }));
    runHook('post-compact', postCompact,
      payload({ session_id: other, transcript_path: otherPath, cwd, compact_summary: SUMMARY }));

    // A second session in the same project database degrades: boundary, no summary anywhere.
    // Its injection must be empty, not the other session's index — anchor ids are session-local,
    // so a cross-session entry could not even be retrieved.
    const session = 'fix-cross';
    const path = writeTranscript(cwd, session, [
      userText(session, 'y1', 'How should the renderer bound the digest tier?'),
      assistantText(session, 'y2',
        'The digest is bounded by its token budget rather than its entry cap, so a cycle of long excerpts renders fewer entries instead of a longer block.'),
      boundaryRecord(session, 'yb3', ['zz-none']),
    ]);
    runHook('pre-compact', preCompact, payload({ session_id: session, transcript_path: path, cwd }));
    runHook('post-compact', postCompact, payload({ session_id: session, transcript_path: path, cwd }));

    expect(runHook('session-start', sessionStart, payload({ session_id: session, cwd, source: 'compact' }))).toBe('');
  });

  it('recovers the summary from the transcript when the payload omits it, and reconciles only the compacting cycle', () => {
    const cwd = join(HOME, 'project-fallback');
    const session = 'fix-fallback';
    const path = writeTranscript(cwd, session, [
      ...readFileSync(SEVEN_TYPES, 'utf8').split('\n').filter((l) => l.trim() !== ''),
      boundaryRecord(session, 'b9', ['u7']),
      summaryRecord(session, 's10', SUMMARY),
    ]);

    runHook('pre-compact', preCompact, payload({ session_id: session, transcript_path: path, cwd }));
    runHook('post-compact', postCompact, payload({ session_id: session, transcript_path: path, cwd }));

    const db = openDb(projectSlug(cwd));
    expect(db.prepare('SELECT summary FROM cycles').all()).toEqual([{ summary: SUMMARY }]);
    expect(count(db, 'FROM anchors WHERE verdict IS NOT NULL')).toBe(9);
    db.close();

    // The session keeps going and compacts a second time, again with no summary in the payload.
    appendFileSync(path, `${[
      userText(session, 'u11', 'Keep the archive writer batching under the same cap.'),
      boundaryRecord(session, 'b12', ['u11']),
      summaryRecord(session, 's13', SECOND_SUMMARY),
      userText(session, 'u14', 'Never widen the anchor id grammar without bumping the major.'),
    ].join('\n')}\n`);
    runHook('pre-compact', preCompact, payload({ session_id: session, transcript_path: path, cwd }));
    runHook('post-compact', postCompact, payload({ session_id: session, transcript_path: path, cwd }));

    const after = openDb(projectSlug(cwd));
    // Cycle 0's verdicts are already final. Re-scoring them against a summary that never described
    // them would flip the one anchor the preserved set saved, and teach drop-rate from a
    // population that never existed.
    expect(after.prepare("SELECT id FROM anchors WHERE cycle = 0 AND verdict = 'kept'").all())
      .toEqual([{ id: 't7u1' }]);
    expect(count(after, "FROM anchors WHERE cycle = 1 AND verdict = 'kept'")).toBe(1);
    // u14 arrived after the boundary, so it belongs to the cycle that has not compacted yet.
    expect(count(after, 'FROM anchors WHERE cycle = 2 AND verdict IS NOT NULL')).toBe(0);
    after.close();
  });
});

// The hardest safety property in the design: no hook can break compaction. Both cases assert the
// same two things — nothing on stdout, and no throw reaching the caller that exits 0.
describe('fail-open', () => {
  it('swallows a throwing hook body, writes nothing to stdout, and records the reason in the log table', () => {
    const cwd = join(HOME, 'project-throw');
    const out = runHook('pre-compact', () => {
      throw new Error('deliberate hook failure');
    }, payload({ session_id: 'fix-throw', cwd }));
    expect(out).toBe('');

    const db = openDb(projectSlug(cwd));
    expect(db.prepare("SELECT hook, msg FROM log WHERE level = 'error'").all()).toEqual([
      { hook: 'pre-compact', msg: 'Error: deliberate hook failure' },
    ]);
    db.close();
  });

  it('still writes nothing to stdout when the state directory itself is unusable, so the failed log write cannot cost the exit code', () => {
    const cwd = join(HOME, 'project-blocked');
    // A file where the state directory belongs: opening the database throws, and so does the
    // best-effort log write that would report it.
    const stateDir = join(HOME, '.claude', 'sebastian');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, projectSlug(cwd)), 'not a directory');

    expect(runHook('pre-compact', preCompact, payload({ session_id: 'fix-blocked', cwd }))).toBe('');
  });

  // An empty payload also produces empty stdout, so stdout alone cannot tell the two apart: the
  // log row is the only place a payload silently read as `{}` shows up.
  it('records a malformed payload as a parse failure rather than proceeding on an empty one', () => {
    expect(runHook('post-compact', postCompact, '{not json')).toBe('');

    // Nothing parsed, so no cwd was available: the failure is logged against the process working
    // directory, which is the only project slug the hook can still name.
    const db = openDb(projectSlug(process.cwd()));
    const rows = db.prepare("SELECT hook, msg FROM log WHERE level = 'error'").all();
    db.close();
    expect(rows.map((r) => r.hook)).toEqual(['post-compact']);
    expect(String(rows[0]?.msg)).toContain('SyntaxError');
  });

  // `main` is the process edge, and the exit code is the whole fail-open contract as Claude Code
  // sees it: every hook path exits 0 whatever happened, and only a command Sebastian does not
  // recognize at all may exit non-zero.
  it('exits 0 from every hook path, including an unknown or missing hook name, and 1 only for an unrecognized command', async () => {
    expect(await main(['hook', 'no-such-hook'])).toBe(0);
    expect(await main(['hook'])).toBe(0);
    expect(await main(['search', 'anything'])).toBe(1);
    expect(await main([])).toBe(1);
  });
});
