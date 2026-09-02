import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { dbPath, latestCycle, openDb, projectSlug } from '../src/store/db.js';
import { renderForgottenIndex } from '../src/reconcile/render.js';
import { readSummary } from '../src/reconcile/cycle.js';
import { parseTranscript, readBoundaries } from '../src/transcript/parse.js';
import { runHook } from '../src/hooks/runHook.js';
import { reconcileCommand } from '../src/cli/reconcile.js';
import { status } from '../src/cli/status.js';
import { HOOKS, main } from '../src/index.js';

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

// The anchor id an index entry points at, and the ids a query holds. An injected entry that names
// an id from another cycle or another session cannot be retrieved: ids are session-local.
const entryIds = (text: string): string[] => entryLines(text).map((l) => l.split(' ')[1] ?? '');

const anchorIds = (db: DatabaseSync, where: string): string[] =>
  db.prepare(`SELECT id FROM anchors ${where}`).all().map((r) => String(r.id));

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

function injectedAs(out: string, event: string): string {
  const parsed = JSON.parse(out) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe(event);
  return parsed.hookSpecificOutput.additionalContext;
}

const injected = (out: string): string => injectedAs(out, 'SessionStart');

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

  it('archives the delta and prints steering, hands the cycle on from PostCompact, then closes and injects it on the next prompt', () => {
    const path = writeTranscript(cwd, session, before);

    // PreCompact. Its stdout is the compact-instruction channel, and an empty database earns no
    // adaptive line, so the block is the base golden byte for byte.
    const steering = runHook('pre-compact', HOOKS['pre-compact'],
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

    // PostCompact. Nothing reaches the user, so stdout stays empty. It closes nothing: the platform
    // writes the boundary record only after this hook's process exits, so the cycle is handed on.
    expect(runHook('post-compact', HOOKS['post-compact'],
      payload({ session_id: session, transcript_path: path, cwd, hook_event_name: 'PostCompact' })))
      .toBe('');

    const handed = openDb(projectSlug(cwd));
    expect(count(handed, 'FROM cycles')).toBe(0);
    expect(count(handed, 'FROM anchors WHERE verdict IS NOT NULL')).toBe(0);
    expect(handed.prepare('SELECT cycle FROM pending').all()).toEqual([{ cycle: 0 }]);
    handed.close();

    // UserPromptSubmit, on the user's next message. It closes the cycle and injects in one pass.
    // The trigger recorded is the boundary's own `auto`, which is what the platform wrote.
    const context = injectedAs(runHook('user-prompt-submit', HOOKS['user-prompt-submit'],
      payload({ session_id: session, transcript_path: path, cwd })), 'UserPromptSubmit');

    const after = openDb(projectSlug(cwd));
    expect(after.prepare('SELECT cycle, trigger, summary FROM cycles').all()).toEqual([
      { cycle: 0, trigger: 'auto', summary: SUMMARY },
    ]);
    expect(count(after, 'FROM pending')).toBe(0);
    // t7u1 rides the preserved-uuid stage to kept at 1.0 without consulting the summary; the
    // remaining 10 anchors share no token and no identifier with it, so they all drop.
    expect(after.prepare("SELECT id, score FROM anchors WHERE verdict = 'kept'").all())
      .toEqual([{ id: 't7u1', score: 1 }]);
    expect(count(after, "FROM anchors WHERE verdict = 'dropped'")).toBe(10);
    // The three records compaction appended after PreCompact ran — the boundary, the summary and
    // the restoration — are archived here, because nothing else would and they do not outlive
    // transcript cleanup. They yield no anchors.
    expect(count(after, 'FROM messages')).toBe(14);
    expect(count(after, "FROM messages WHERE uuid IN ('b11', 's12', 'at13')")).toBe(3);
    expect(count(after, 'FROM anchors')).toBe(11);
    after.close();

    // Every listable drop fits the budget: 3 error, 1 answer, 1 edit, 2 read, 1 url. The 2 cmd
    // drops and the kept user anchor never spend an entry.
    expect(context.startsWith('## Forgotten Index\n')).toBe(true);
    expect(context).toContain('Dropped this cycle: 3 error, 1 answer, 1 edit, 2 cmd, 2 read, 1 url (11 anchors reconciled).');
    expect(entryLines(context)).toHaveLength(8);
    expect(estimateTokens(context)).toBeLessThanOrEqual(400);
  });
});

// The budget is the only thing that bounds an injection once every drop is listable.
describe('injection budget', () => {
  const cwd = join(HOME, 'project-budget');
  const session = 'fix-budget';

  // Twelve question-and-answer pairs, so the cycle drops twelve `answer` anchors. Each reply runs
  // past the entry display width, so twelve entries cannot fit the budget, which is what makes the
  // arithmetic below hold.
  const pairs: [string, string, string, string][] = [
    ['u1', 'a2', 'Why does the summarizer drop long explanations first?',
      'The summarizer keeps identifiers when the compact instructions name them, and it collapses prose first, so a long session loses explanation before it loses a file path.'],
    ['u3', 'a4', 'How does the reconciler decide that an anchor survived?',
      'An anchor survives when its message stays in context verbatim, or when the platform restores the file it names, and only the rest reach text matching.'],
    ['u5', 'a6', 'What happens when the transcript field arrives empty?',
      'An empty transcript field falls back to the newest file named for the session under the projects directory, and nothing is archived when no such file exists.'],
    ['u7', 'a8', 'When does an index entry earn its tokens?',
      'An entry earns its tokens when the anchor it names was ruled dropped and no earlier round of the fill has spent the ceiling, so each type gets a turn ahead of any second turn.'],
    ['u9', 'a10', 'How does search reach across sessions?',
      'Search reads the whole project database rather than one session, and a result set that spans sessions qualifies each id with its session prefix so that show can resolve it.'],
    ['u11', 'a12', 'What does the steering block say on a fresh database?',
      'A fresh database prints the base lines alone, because no verdict exists yet and an adaptive line without a drop-rate behind it would be a constant rather than a signal.'],
    ['u13', 'a14', 'Where does the archive live on disk?',
      'The archive lives in one SQLite file per project under the state directory, named from a slug of the working directory, so a second checkout of one repository never shares a file.'],
    ['u15', 'a16', 'Which anchors never spend injected tokens?',
      'Command anchors never spend injected tokens because a command line is the means of acquisition rather than the thing acquired, and user anchors wait until retrieval telemetry earns them a slot.'],
    ['u17', 'a18', 'How is a turn number defined?',
      'A turn is the record position in the transcript file, counting every record whether or not it yields an anchor, so a change in which record types the parser classifies cannot move an id.'],
    ['u19', 'a20', 'Why is the reader the hardening pass?',
      'The reader already holds the summary, so it can resolve a flagged paraphrase against it at zero latency, which is cheaper and more deterministic than any subprocess a hook could spawn.'],
    ['u21', 'a22', 'Why does PostCompact leave the cycle pending instead of closing it?',
      'PostCompact leaves the cycle pending because the platform appends the boundary record only after the hook process exits, so the record it would need is never on disk while it runs.'],
    ['u23', 'a24', 'What does the session prefix in the footer buy the reader?',
      'The session prefix in the footer makes every retrieval command unambiguous across an archive holding several sessions, at the cost of one prefix rather than one per entry.'],
  ];

  const transcript = [
    ...pairs.flatMap(([q, a, question, answer]) => [
      userText(session, q, question),
      assistantText(session, a, answer),
    ]),
    // Two records that carry no anchor: a one-word thanks has too few content tokens, and its
    // reply answers no pending question. Preserving them keeps the preserved set realistic
    // without keeping an anchor.
    userText(session, 'u25', 'Thanks.'),
    assistantText(session, 'a26', 'Done.'),
    boundaryRecord(session, 'b27', ['u25', 'a26']),
    summaryRecord(session, 's28', SUMMARY),
  ];

  it('bounds the injected index by its token budget, listing fewer entries than the untruncated index holds', () => {
    const path = writeTranscript(cwd, session, transcript);
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));
    runHook('post-compact', HOOKS['post-compact'],
      payload({ session_id: session, transcript_path: path, cwd, compact_summary: SUMMARY }));

    const context = injectedAs(runHook('user-prompt-submit', HOOKS['user-prompt-submit'],
      payload({ session_id: session, transcript_path: path, cwd })), 'UserPromptSubmit');
    expect(context).toContain('Dropped this cycle: 12 answer (12 anchors reconciled).');

    // The same ten entries with no budget pressure exceed the budget, and the injection therefore
    // renders fewer of them. Both halves are needed: the first alone would pass with any budget at
    // all, and the second alone would pass if the renderer capped entries instead of tokens.
    const db = openDb(projectSlug(cwd));
    const cycle = latestCycle(db, session);
    const untruncated = renderForgottenIndex(cycle?.verdicts ?? [], cycle?.anchors ?? [], 4000);
    db.close();
    expect(entryLines(untruncated)).toHaveLength(12);
    expect(estimateTokens(untruncated)).toBeGreaterThan(400);
    expect(estimateTokens(context)).toBeLessThanOrEqual(400);
    expect(entryLines(context).length).toBeLessThan(12);
    expect(entryLines(context).length).toBeGreaterThan(0);
  });

  it('emits a one-line availability note for matcher resume, not an index', () => {
    const context = injected(runHook('session-start', HOOKS['session-start'],
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

    expect(runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: '', cwd })))
      .toBe(readFileSync(STEERING_BASE, 'utf8'));
    const db = openDb(projectSlug(cwd));
    expect(count(db, 'FROM messages')).toBe(9);

    // No file anywhere for this session id: the archive is skipped, the steering channel is not.
    expect(runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: 'no-such-session', transcript_path: '', cwd })))
      .toBe(readFileSync(STEERING_BASE, 'utf8'));
    expect(count(db, 'FROM messages')).toBe(9);
    expect(count(db, "FROM log WHERE level = 'warn'")).toBe(1);
    db.close();
  });

  it('leaves every verdict NULL when neither the payload nor the transcript carries a summary, and injects the cycle labelled unreconciled', () => {
    const cwd = join(HOME, 'project-nosummary');
    // The fixture's own session id: anchors carry the id written in the records, so a cycle row
    // recorded under any other id would address none of them.
    const session = 'fix-seven';
    const path = writeTranscript(cwd, session, [
      ...readFileSync(SEVEN_TYPES, 'utf8').split('\n').filter((l) => l.trim() !== ''),
      boundaryRecord(session, 'b9', ['u7']),
    ]);

    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));
    expect(runHook('post-compact', HOOKS['post-compact'], payload({ session_id: session, transcript_path: path, cwd }))).toBe('');

    const db = openDb(projectSlug(cwd));
    // The cycle happened, so it is recorded — but matching against nothing would rule every
    // anchor dropped at score 0 and poison drop-rate for every later cycle, so no verdict lands
    // and the row stays unstamped.
    expect(db.prepare('SELECT cycle, summary, reconciled_at FROM cycles').all()).toEqual([
      { cycle: 0, summary: null, reconciled_at: null },
    ]);
    expect(count(db, 'FROM anchors WHERE verdict IS NOT NULL')).toBe(0);
    db.close();

    // Nothing was checked, so nothing may read as dropped — but the anchors that existed before
    // the boundary are still the reader's pointer, and they inject under the unreconciled label.
    const context = injectedAs(runHook('user-prompt-submit', HOOKS['user-prompt-submit'],
      payload({ session_id: session, transcript_path: path, cwd })), 'UserPromptSubmit');
    expect(context).toContain('## Forgotten Index — unreconciled');
    expect(context).not.toContain('Dropped this cycle');
    expect(entryLines(context).length).toBeGreaterThan(0);
  });

  it('cedes precedence to a /compact argument with one appended line, so steering cannot contradict an explicit user instruction', () => {
    const cwd = join(HOME, 'project-custom');
    const out = runHook('pre-compact', HOOKS['pre-compact'],
      payload({ session_id: 'fix-custom', cwd, custom_instructions: 'focus on the auth work' }));
    expect(out).toBe(`${readFileSync(STEERING_BASE, 'utf8')}- The user's own compact instructions take precedence over the lines above wherever they conflict.\n`);

    // The probe observed custom_instructions: null on a bare /compact — no line for null, and
    // none for whitespace either.
    expect(runHook('pre-compact', HOOKS['pre-compact'],
      payload({ session_id: 'fix-custom', cwd, custom_instructions: null })))
      .toBe(readFileSync(STEERING_BASE, 'utf8'));
    expect(runHook('pre-compact', HOOKS['pre-compact'],
      payload({ session_id: 'fix-custom', cwd, custom_instructions: '  ' })))
      .toBe(readFileSync(STEERING_BASE, 'utf8'));
  });




  // The full production ordering, which no earlier test reproduced: PreCompact, then SessionStart
  // 106 ms before PostCompact, then PostCompact, then the boundary, then the user's next message.
  // Under this ordering SessionStart has nothing settled to inject and UserPromptSubmit delivers.
  it('closes a cycle PostCompact could not reach and delivers its index on the next user message, exactly once', () => {
    const cwd = join(HOME, 'project-ordering');
    const session = 'fix-ordering';
    const path = writeTranscript(cwd, session,
      readFileSync(SEVEN_TYPES, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => l.replaceAll('fix-seven', session)));
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));

    // SessionStart fires before the cycle exists, exactly as the live logs recorded, and says so
    // rather than injecting whatever older cycle the session holds.
    expect(injected(runHook('session-start', HOOKS['session-start'], payload({ session_id: session, cwd, source: 'compact' }))))
      .toContain('not ready yet');

    // The platform writes the boundary and summary after PostCompact exits, which is the only
    // ordering the live logs show. A synchronous append after the call reproduces it exactly.
    runHook('post-compact', HOOKS['post-compact'],
      payload({ session_id: session, transcript_path: path, cwd }));

    // PostCompact hands the cycle on rather than closing it.
    const handed = openDb(projectSlug(cwd));
    expect(count(handed, 'FROM cycles')).toBe(0);
    expect(count(handed, 'FROM pending')).toBe(1);
    handed.close();

    appendFileSync(path, `${[
      boundaryRecord(session, 'b11', ['zz-none']),
      summaryRecord(session, 's12', SUMMARY),
    ].join('\n')}\n`);
    const first = runHook('user-prompt-submit', HOOKS['user-prompt-submit'], payload({ session_id: session, transcript_path: path, cwd }));
    const context = injectedAs(first, 'UserPromptSubmit');
    expect(context).toContain('## Forgotten Index');
    expect(entryIds(context).length).toBeGreaterThan(0);

    const db = openDb(projectSlug(cwd));
    expect(count(db, 'FROM cycles WHERE reconciled_at IS NOT NULL')).toBe(1);
    expect(count(db, 'FROM pending')).toBe(0);
    db.close();

    // The budget is spent once. A second prompt in the same session must not repeat the index, and
    // a later SessionStart after a compaction injects its note, never the index.
    expect(runHook('user-prompt-submit', HOOKS['user-prompt-submit'], payload({ session_id: session, transcript_path: path, cwd }))).toBe('');
    expect(injected(runHook('session-start', HOOKS['session-start'], payload({ session_id: session, cwd, source: 'compact' }))))
      .not.toContain('## Forgotten Index');
  });

  // The eval harness drives SessionStart with source compact and discards what it prints, so it can
  // never see that print. Before this branch existed, a session's second compaction injected the
  // first compaction's index under a header reading "this cycle", 4.5 hours stale in the live log.
  it('SessionStart after a compaction does not deliver the previous cycle\'s index as if it were this one, and does not mark it delivered', () => {
    const cwd = join(HOME, 'project-previous');
    const session = 'fix-previous';
    const path = writeTranscript(cwd, session, [
      userText(session, 'u1', 'Why does the archiver skip crash-torn trailing lines?'),
      assistantText(session, 'a2',
        'A crash-torn trailing line fails to parse, so the archiver skips that one record and keeps every complete earlier line instead of aborting the delta.'),
      boundaryRecord(session, 'b3', ['zz-none']),
      summaryRecord(session, 's4', SUMMARY),
    ]);
    // PreCompact closes the cycle whose boundary is already on disk: settled, and never injected.
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));
    const before = openDb(projectSlug(cwd));
    expect(before.prepare('SELECT cycle, reconciled_at IS NOT NULL AS settled, injected_at, injected_tokens FROM cycles').all())
      .toEqual([{ cycle: 0, settled: 1, injected_at: null, injected_tokens: null }]);
    before.close();

    // The next compaction starts. Its own cycle is not recorded yet; the only settled cycle is the
    // previous one, and it must not go out as this one.
    const context = injected(runHook('session-start', HOOKS['session-start'],
      payload({ session_id: session, cwd, source: 'compact' })));
    expect(context).toBe(
      'Sebastian archived this compaction. Its Forgotten Index is not ready yet: it arrives with your next message, or run `seb index` now.',
    );

    // The note is charged to the newest cycle, and the cycle stays undelivered.
    const after = openDb(projectSlug(cwd));
    expect(after.prepare('SELECT injected_at, injected_tokens FROM cycles').all())
      .toEqual([{ injected_at: null, injected_tokens: estimateTokens(context) }]);
    after.close();
  });

  // The matcher sends only `compact` and `resume`, so the harness never drives any other source. If
  // Claude Code renamed the field, a compact-triggered start would arrive unrecognized, and the only
  // settled cycle it could inject is the previous compaction's.
  it('SessionStart with a source the matcher never sends injects nothing, so a renamed field cannot deliver a previous cycle\'s index as this one', () => {
    const cwd = join(HOME, 'project-unknown-source');
    const session = 'fix-unknown-source';
    const path = writeTranscript(cwd, session, [
      userText(session, 'u1', 'Why does the archiver skip crash-torn trailing lines?'),
      assistantText(session, 'a2',
        'A crash-torn trailing line fails to parse, so the archiver skips that one record and keeps every complete earlier line instead of aborting the delta.'),
      boundaryRecord(session, 'b3', ['zz-none']),
      summaryRecord(session, 's4', SUMMARY),
    ]);
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));

    expect(runHook('session-start', HOOKS['session-start'],
      payload({ session_id: session, cwd, source: 'startup' }))).toBe('');

    const db = openDb(projectSlug(cwd));
    expect(db.prepare('SELECT cycle, reconciled_at IS NOT NULL AS settled, injected_at, injected_tokens FROM cycles').all())
      .toEqual([{ cycle: 0, settled: 1, injected_at: null, injected_tokens: null }]);
    db.close();
  });

  // What the three live compactions produced: anchors archived, boundary on disk, no cycles row,
  // verdicts NULL forever. Correctness cannot rest on the wait winning, so the next compaction
  // closes whatever the last one left open.
  it('reconciles a cycle that an earlier compaction left stranded, without any hook having observed it', () => {
    const cwd = join(HOME, 'project-catchup');
    const session = 'fix-catchup';
    const path = writeTranscript(cwd, session, [
      userText(session, 'u1', 'Why does the archiver skip crash-torn trailing lines?'),
      assistantText(session, 'a2',
        'A crash-torn trailing line fails to parse, so the archiver skips that one record and keeps every complete earlier line instead of aborting the delta.'),
    ]);
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));

    // The compaction happens and PostCompact never closes it — an expired wait, a crash, or a
    // plugin installed mid-session.
    appendFileSync(path, `${[
      boundaryRecord(session, 'b3', ['zz-none']),
      summaryRecord(session, 's4', SUMMARY),
    ].join('\n')}\n`);

    const stranded = openDb(projectSlug(cwd));
    expect(count(stranded, 'FROM cycles')).toBe(0);
    expect(count(stranded, 'FROM anchors WHERE verdict IS NOT NULL')).toBe(0);
    stranded.close();

    appendFileSync(path, `${userText(session, 'u5', 'Keep the archive writer batching under the same cap.')}\n`);
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));

    const db = openDb(projectSlug(cwd));
    expect(db.prepare('SELECT cycle, summary FROM cycles').all()).toEqual([{ cycle: 0, summary: SUMMARY }]);
    expect(count(db, 'FROM cycles WHERE reconciled_at IS NOT NULL')).toBe(1);
    expect(count(db, 'FROM anchors WHERE cycle = 0 AND verdict IS NOT NULL')).toBeGreaterThan(0);
    db.close();
  });

  // Three live compactions failed this way and nothing said so. `seb status` reported the counts
  // honestly but neutrally, and neutral counts are what a reader skips.
  it('reports a compaction it could not close, and stops reporting it once the cycle is reconciled', () => {
    const cwd = join(HOME, 'project-health');
    const session = 'fix-health';
    const path = writeTranscript(cwd, session,
      readFileSync(SEVEN_TYPES, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => l.replaceAll('fix-seven', session)));
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));

    // An archive holding anchors and no cycle is not yet a fault: this project has not compacted.
    const quiet = openDb(projectSlug(cwd));
    expect(status(quiet, [])).not.toContain('not yet closed');
    quiet.close();

    // PostCompact runs and the boundary never arrives, which is the live failure exactly.
    runHook('post-compact', HOOKS['post-compact'], payload({ session_id: session, transcript_path: path, cwd }));

    const broken = openDb(projectSlug(cwd));
    expect(status(broken, [])).toContain('1 compaction not yet closed — run `seb reconcile` or compact again.');
    broken.close();

    appendFileSync(path, `${[
      boundaryRecord(session, 'b9', ['u7']),
      summaryRecord(session, 's10', SUMMARY),
    ].join('\n')}\n`);
    const db = openDb(projectSlug(cwd));
    reconcileCommand(db, []);
    expect(status(db, [])).not.toContain('not yet closed');
    expect(count(db, 'FROM pending')).toBe(0);
    db.close();
  });

  // The on-demand form of the same recovery, for a backlog nobody wants to wait a compaction to
  // clear. Reported per cycle, because "recovered 3" without the cycles is not checkable.
  it('recovers a stranded cycle on demand and reports each one, deriving the same verdicts a hook would', () => {
    const cwd = join(HOME, 'project-cli-recover');
    const session = 'fix-recover';
    const path = writeTranscript(cwd, session,
      readFileSync(SEVEN_TYPES, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => l.replaceAll('fix-seven', session)));
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));

    // The compaction lands after PreCompact, and nothing closes it.
    appendFileSync(path, `${[
      boundaryRecord(session, 'b9', ['u7']),
      summaryRecord(session, 's10', SUMMARY),
    ].join('\n')}\n`);

    const db = openDb(projectSlug(cwd));
    expect(reconcileCommand(db, [])).toBe(
      '- fix-reco cycle 0: 9 verdicts over 9 anchors\nRecovered 1 cycle.\n',
    );

    // The one anchor the preserved set saved, which is what proves the verdicts were derived rather
    // than defaulted: a cycle scored against nothing rules every anchor dropped.
    expect(anchorIds(db, "WHERE verdict = 'kept'")).toEqual(['t7u1']);
    expect(reconcileCommand(db, [])).toBe('Nothing to reconcile: every closed cycle has a row.\n');
    db.close();
  });

  // A cycle whose summary never landed can never earn verdicts. Keyed on anchors with null
  // verdicts, such a cycle would be re-parsed by every hook for the life of the archive.
  it('stops revisiting a recovered cycle, including one whose summary can never be found', () => {
    const cwd = join(HOME, 'project-catchup-terminal');
    const session = 'fix-catchup-terminal';
    const path = writeTranscript(cwd, session, [
      userText(session, 'u1', 'Why does the archiver skip crash-torn trailing lines?'),
      boundaryRecord(session, 'b2', ['zz-none']),
    ]);
    const recoveries = (db: DatabaseSync): number =>
      count(db, "FROM log WHERE msg LIKE 'recovered cycle%'");

    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));
    const first = openDb(projectSlug(cwd));
    expect(first.prepare('SELECT cycle, summary, reconciled_at FROM cycles').all())
      .toEqual([{ cycle: 0, summary: null, reconciled_at: null }]);
    expect(recoveries(first)).toBe(1);
    first.close();

    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));

    const db = openDb(projectSlug(cwd));
    expect(recoveries(db)).toBe(1);
    db.close();
  });

  // Recovery reconciles boundaries that are no longer the last one in the file, so the summary
  // lookup has to be anchored to its own boundary. Taking the newest summary above the cycle reads
  // the same in a one-boundary transcript and silently wrong in every other.
  it('resolves each boundary to the summary that follows it, not to the newest summary in a transcript that holds two', () => {
    const cwd = join(HOME, 'project-two-summaries');
    const session = 'fix-two-summaries';
    const path = writeTranscript(cwd, session, [
      userText(session, 'u1', 'Why does the archiver skip crash-torn trailing lines?'),
      boundaryRecord(session, 'b2', ['zz-none']),
      summaryRecord(session, 's3', SUMMARY),
      userText(session, 'u4', 'How does the store deduplicate messages archived twice?'),
      boundaryRecord(session, 'b5', ['zz-none']),
      summaryRecord(session, 's6', SECOND_SUMMARY),
    ]);
    const events = parseTranscript(path);
    const boundaries = readBoundaries(events);
    expect(boundaries.map((b) => b.cycle)).toEqual([0, 1]);
    expect(boundaries.map((b) => readSummary(events, b))).toEqual([SUMMARY, SECOND_SUMMARY]);

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
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));
    runHook('post-compact', HOOKS['post-compact'],
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
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));
    runHook('post-compact', HOOKS['post-compact'], payload({ session_id: session, transcript_path: path, cwd }));

    const db = openDb(projectSlug(cwd));
    expect(db.prepare('SELECT cycle, summary, reconciled_at FROM cycles WHERE cycle = 1').all()).toEqual([
      { cycle: 1, summary: null, reconciled_at: null },
    ]);
    expect(count(db, 'FROM anchors WHERE cycle = 1 AND verdict IS NOT NULL')).toBe(0);
    const thisCycle = anchorIds(db, 'WHERE cycle = 1');
    db.close();

    // The session's latest cycle injects its own anchors under the unreconciled label — never
    // cycle 0's verdicts relabelled as this cycle's.
    const context = injectedAs(runHook('user-prompt-submit', HOOKS['user-prompt-submit'],
      payload({ session_id: session, transcript_path: path, cwd })), 'UserPromptSubmit');
    expect(context).toContain('## Forgotten Index — unreconciled');
    expect(entryIds(context).length).toBeGreaterThan(0);
    expect(entryIds(context).filter((id) => !thisCycle.includes(id))).toEqual([]);
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
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: other, transcript_path: otherPath, cwd }));
    runHook('post-compact', HOOKS['post-compact'],
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
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));
    runHook('post-compact', HOOKS['post-compact'], payload({ session_id: session, transcript_path: path, cwd }));

    const db = openDb(projectSlug(cwd));
    const mine = anchorIds(db, `WHERE session_id = '${session}'`);
    db.close();

    const context = injectedAs(runHook('user-prompt-submit', HOOKS['user-prompt-submit'],
      payload({ session_id: session, transcript_path: path, cwd })), 'UserPromptSubmit');
    expect(context).toContain('## Forgotten Index — unreconciled');
    expect(entryIds(context).length).toBeGreaterThan(0);
    expect(entryIds(context).filter((id) => !mine.includes(id))).toEqual([]);
  });

  it('recovers the summary from the transcript when the payload omits it, and reconciles only the compacting cycle', () => {
    const cwd = join(HOME, 'project-fallback');
    const session = 'fix-fallback';
    const path = writeTranscript(cwd, session, [
      ...readFileSync(SEVEN_TYPES, 'utf8').split('\n').filter((l) => l.trim() !== ''),
      boundaryRecord(session, 'b9', ['u7']),
      summaryRecord(session, 's10', SUMMARY),
    ]);

    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));
    runHook('post-compact', HOOKS['post-compact'], payload({ session_id: session, transcript_path: path, cwd }));

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
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd }));
    runHook('post-compact', HOOKS['post-compact'], payload({ session_id: session, transcript_path: path, cwd }));

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

// UserPromptSubmit runs on every prompt in every project. A read-only hook that opened the database
// would give every directory the user types in an archive it never earned, and would make the
// "fills at the first compaction" promise false.
describe('archive creation', () => {
  it('leaves no archive behind for a project that has never compacted, and still injects for one that has', () => {
    const fresh = join(HOME, 'project-never-compacted');
    expect(runHook('user-prompt-submit', HOOKS['user-prompt-submit'],
      payload({ session_id: 'fix-fresh', cwd: fresh }))).toBe('');
    expect(runHook('session-start', HOOKS['session-start'],
      payload({ session_id: 'fix-fresh', cwd: fresh, source: 'compact' }))).toBe('');
    expect(existsSync(dbPath(projectSlug(fresh)))).toBe(false);

    // PreCompact is allowed to create one, which is what earns the project an archive.
    const session = 'fix-earns';
    const path = writeTranscript(fresh, session, [
      userText(session, 'u1', 'Why does the archiver skip crash-torn trailing lines?'),
    ]);
    runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: session, transcript_path: path, cwd: fresh }));
    expect(existsSync(dbPath(projectSlug(fresh)))).toBe(true);
  });

  // The payload carries no cwd, so the slug a failure would log into is the process working
  // directory. Claude Code sends valid JSON, so this path is reached only by a broken caller, and
  // that caller must not be what earns a directory an archive.
  it('leaves no archive behind when a read-only hook receives a payload that does not parse', () => {
    const scratch = join(HOME, 'project-bad-payload');
    mkdirSync(scratch, { recursive: true });
    const previous = process.cwd();
    process.chdir(scratch);
    try {
      expect(runHook('user-prompt-submit', HOOKS['user-prompt-submit'], '{not json')).toBe('');
      expect(existsSync(dbPath(projectSlug(process.cwd())))).toBe(false);
    } finally {
      process.chdir(previous);
    }
  });
});

// The hardest safety property in the design: no hook can break compaction. Both cases assert the
// same two things — nothing on stdout, and no throw reaching the caller that exits 0.
describe('fail-open', () => {
  it('swallows a throwing hook body, writes nothing to stdout, and records the reason in the log table', () => {
    const cwd = join(HOME, 'project-throw');
    const out = runHook('pre-compact', {
      creates: true,
      body: () => {
        throw new Error('deliberate hook failure');
      },
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

    expect(runHook('pre-compact', HOOKS['pre-compact'], payload({ session_id: 'fix-blocked', cwd }))).toBe('');
  });

  // An empty payload also produces empty stdout, so stdout alone cannot tell the two apart: the
  // log row is the only place a payload silently read as `{}` shows up.
  it('records a malformed payload as a parse failure rather than proceeding on an empty one', () => {
    expect(runHook('post-compact', HOOKS['post-compact'], '{not json')).toBe('');

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
    expect(await main(['frobnicate'])).toBe(1);
    expect(await main([])).toBe(1);
  });
});
