import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import {
  archiveDelta, logEvent, openDb, openDbAt, persistVerdicts, projectSlug, recordCycle,
  type ArchivedMessage,
} from '../src/store/db.js';
import { extractAnchors } from '../src/transcript/anchors.js';
import { parseTranscript } from '../src/transcript/parse.js';
import { capOutput } from '../src/cli/output.js';
import { search } from '../src/cli/search.js';
import { fitWindow, show } from '../src/cli/show.js';
import { indexCommand } from '../src/cli/index.js';
import { timeline } from '../src/cli/timeline.js';
import { status } from '../src/cli/status.js';
import { report } from '../src/cli/report.js';
import { main } from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/seven-types.jsonl', import.meta.url));

const golden = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./golden/${name}`, import.meta.url)), 'utf8');

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

const tempDb = (prefix: string): DatabaseSync => openDbAt(join(tempDir(prefix), 'sebastian.db'));

// A record of a known size at a known turn. Every header is 39 characters, which is what makes the
// window goldens derivable with arithmetic instead of by running the code.
const msg = (turn: number, raw: string): ArchivedMessage => ({
  sessionId: 'fix-seven',
  turn,
  cycle: 0,
  ts: '2026-08-30T10:00:00.000Z',
  role: 'user',
  raw,
});

function archiveFixture(db: DatabaseSync, path: string): void {
  const events = parseTranscript(path);
  archiveDelta(db, events, extractAnchors(events));
}

// A second session of the same shape, in the same project database: same turns, so the same
// session-local ids, which is the collision the qualified display form exists for. Uuids are
// rewritten because they are the archive's dedupe key across sessions.
function secondSession(): string {
  const text = readFileSync(FIXTURE, 'utf8')
    .replaceAll('"fix-seven"', '"fix-second"')
    .replaceAll(/"uuid":"([^"]+)"/g, '"uuid":"s2-$1"');
  const path = join(tempDir('seb-cli-second-'), 'second.jsonl');
  writeFileSync(path, text);
  return path;
}

// Hand-derived verdicts for the fixture's nine anchors: the answer, the error, the URL and the
// user decision are dropped, the four identifiers the summary names are kept. The scores are the
// bands the reconciler produces — 0.00 for no overlap, 0.12 and 0.31 inside the uncertain band.
const VERDICTS = [
  { anchorId: 't1a1', verdict: 'dropped', score: 0.12 },
  { anchorId: 't1r1', verdict: 'kept', score: 1 },
  { anchorId: 't3d1', verdict: 'kept', score: 1 },
  { anchorId: 't3c1', verdict: 'kept', score: 1 },
  { anchorId: 't4e1', verdict: 'dropped', score: 0 },
  { anchorId: 't5c1', verdict: 'kept', score: 1 },
  { anchorId: 't5r1', verdict: 'kept', score: 1 },
  { anchorId: 't5w1', verdict: 'dropped', score: 0 },
  { anchorId: 't7u1', verdict: 'dropped', score: 0.31 },
] as const;

function reconcileFixture(db: DatabaseSync): void {
  persistVerdicts(
    db,
    VERDICTS.map((v) => ({ ...v, sessionId: 'fix-seven' })),
  );
  recordCycle(db, {
    sessionId: 'fix-seven',
    cycle: 0,
    trigger: 'manual',
    summary: 'The sync retry loop was repaired.',
  });
}

// Goldens hand-written from the Retrieval surface section, against a real temporary database. The
// eval harness scores which anchors come back; nothing in it reads a rendered command, so a
// heading, an id form or a truncation that changes is invisible to it and visible here.

describe('cli rendering', () => {
  it('renders one line per hit in transcript order, so a page of search results reads as a session rather than as a relevance ranking', () => {
    const db = tempDb('seb-cli-search-');
    archiveFixture(db, FIXTURE);
    expect(search(db, ['retry'])).toBe(golden('cli-search.txt'));
    db.close();
  });

  it('qualifies ids with the session prefix only once a result set spans two sessions, and resolves that prefix back to one record', () => {
    const db = tempDb('seb-cli-cross-');
    archiveFixture(db, FIXTURE);
    archiveFixture(db, secondSession());
    expect(search(db, ['retry'])).toBe(golden('cli-search-cross-session.txt'));

    // The bare id now names two rows, and answering with either one would be a wrong record
    // returned as a right one.
    expect(() => show(db, ['t7u1'])).toThrow(
      't7u1 exists in 2 sessions: fix-seco/t7u1, fix-seve/t7u1 — name one by its prefix',
    );
    expect(show(db, ['fix-seco/t7u1'])).toContain('session fix-second, cycle 0, turn 7');

    // `--session` takes the same printed prefix. An unresolvable one is refused rather than
    // answered with an empty result, which a reader cannot tell from an empty archive.
    expect(search(db, ['retry', '--session', 'fix-seco'])).toBe(golden('cli-search.txt'));
    expect(() => search(db, ['retry', '--session', 'fix-s'])).toThrow(
      '"fix-s" matches 2 sessions: fix-second, fix-seven',
    );
    db.close();
  });

  it('lists every dropped anchor with its score, including the types the injected index never spends tokens on', () => {
    const db = tempDb('seb-cli-index-');
    archiveFixture(db, FIXTURE);
    reconcileFixture(db);
    expect(indexCommand(db, ['--dropped', '--raw'])).toBe(golden('cli-index-dropped.txt'));

    // Bare `seb index` is the same render SessionStart injects, over the project's newest
    // reconciled cycle: a dropped `user` anchor is counted there but never listed, and `--dropped`
    // above is the only way to read it.
    const injected = indexCommand(db, []);
    expect(injected).toContain('Dropped this cycle: 1 error, 1 answer, 1 user, 1 url (9 anchors reconciled).');
    expect(injected).toContain('- t4e1 error: TypeError: Cannot read properties of undefined');
    expect(injected).not.toContain('t7u1');
    db.close();
  });

  it('maps every anchor-bearing turn in extraction order, so a reader can aim `seb show` at a position without a query', () => {
    const db = tempDb('seb-cli-timeline-');
    archiveFixture(db, FIXTURE);
    expect(timeline(db, [])).toBe(golden('cli-timeline.txt'));
    db.close();
  });

  // Six 19-character lines are 120 characters, and the budget is 25 tokens at 4 characters each.
  // The footer reserves 11 tokens, leaving 76 characters, so two lines survive and the footer
  // reports the other four. A cap that counted bytes instead of whole lines would cut an id in
  // half, and one that forgot to reserve the footer would exceed the budget it exists to hold.
  it('keeps whole lines within the budget and reports the exact number it left out, so a capped listing never looks complete', () => {
    const lines = ['one', 'two', 'six', 'ten', 'air', 'bee'];
    const text = lines.map((word, i) => `t${i + 1}e1 error c0 — ${word}\n`).join('');
    expect(text).toHaveLength(120);
    expect(capOutput(text, 25)).toBe(golden('cli-cap.txt'));
  });

  // The row order inside a page comes from bm25 rank, which cannot be derived by hand, so what is
  // pinned here is the heading and the trailer — the two lines that say a page is not the whole
  // match. Without them a `--limit 2` page reads exactly like an archive holding two anchors.
  it('states the size of the whole match when the page falls short of it, so a limited search is never read as the whole archive', () => {
    const db = tempDb('seb-cli-limit-');
    archiveFixture(db, FIXTURE);
    const page = search(db, ['retry', '--limit', '2']);
    expect(page).toContain('2 of 6 anchors for "retry" — showing the 2 best matches.\n');
    expect(page).toContain('Raise --limit or narrow with --type, --cycle or --turn to see the rest.\n');

    // An unsaturated page says nothing about limits at all; `cli-search.txt` pins that in full.
    expect(search(db, ['retry'])).toBe(golden('cli-search.txt'));

    // `--limit 0` reached the store as `LIMIT 0` and answered "no anchors match" over six of them.
    expect(() => search(db, ['retry', '--limit', '0'])).toThrow(
      '--limit takes a whole number of results, at least 1',
    );
    db.close();
  });

  // Derived at a 200-character room: the omission footer reserves 67, leaving 133. The header
  // takes 39 and the marker is measured at its widest — 38 — so 56 of the record's 300 characters
  // survive. A whole-lines cap sees one indivisible line here and keeps none of it.
  it('cuts an oversized target record at a character boundary and reports how much it hid, so `seb show` never answers with a footer and no record', () => {
    const records = [msg(4, '{"t":4}'), msg(5, 'ab'.repeat(150)), msg(6, '{"t":6}')];
    expect(fitWindow(records, 5, 200)).toBe(golden('cli-show-truncated.txt'));
  });

  // Turn 4 is bulky and sits between the earlier context and the target. Filling the room in turn
  // order spends all of it there and never reaches turn 5, which is the record that was asked for.
  // Turn 4 is skipped rather than ending the scan, so turns 3 and 6 still make it in.
  it('allocates the target before its context, so a bulky neighbouring turn cannot displace the record that was asked for', () => {
    const records = [
      msg(3, '{"t":3}'), msg(4, 'y'.repeat(200)), msg(5, '{"t":5}'),
      msg(6, '{"t":6}'), msg(7, 'z'.repeat(100)),
    ];
    expect(fitWindow(records, 5, 300)).toBe(golden('cli-show-target-first.txt'));
  });
});

describe('cli retrieval', () => {
  // The round trip the whole archive exists for: find an anchor by words the summary lost, then
  // get the original line back unchanged. Telemetry is the second half — `computeSteering` counts
  // search and show rows with hits above zero, so a command that miscounts its own results
  // silently disables the loop's adaptation.
  it('returns the archived JSONL line byte-identical from an id found by search, and logs per-type hits that steering can count', () => {
    const db = tempDb('seb-cli-roundtrip-');
    archiveFixture(db, FIXTURE);
    const lines = readFileSync(FIXTURE, 'utf8').split('\n');

    expect(search(db, ['exponential', 'backoff'])).toContain('t7u1 user c0 — Keep the exponential');
    const shown = show(db, ['t7u1', '--context', '1']);
    expect(shown).toContain(`turn 7  user  2026-08-30T10:00:40.000Z\n${lines[7]}\n`);
    expect(shown).toContain(lines[6]);
    expect(shown).toContain(lines[8]);

    // A search that found nothing must log a zero, or a miss reads as a recovery.
    expect(search(db, ['nonexistentterm', '--type', 'error'])).toBe(
      'No anchors match "nonexistentterm".\n',
    );

    const rows = db
      .prepare('SELECT cmd, anchor_type, anchor_id, hits FROM telemetry ORDER BY id')
      .all();
    expect(rows.filter((r) => r.cmd === 'search').map((r) => `${String(r.anchor_type)}:${String(r.hits)}`).sort())
      .toEqual(['error:0', 'user:1']);
    expect(rows.filter((r) => r.cmd === 'show')).toEqual([
      { cmd: 'show', anchor_type: 'user', anchor_id: 't7u1', hits: 1 },
    ]);
    db.close();
  });

  // `seb status` is the only command whose output is not reproducible — it carries a path, a byte
  // size and the steering block — so what it pins is the contract every command shares: the
  // telemetry row, and counts taken over the whole project rather than one session.
  it('reports project-wide counts and the steering block the next compaction will print', () => {
    const db = tempDb('seb-cli-status-');
    archiveFixture(db, FIXTURE);
    archiveFixture(db, secondSession());
    reconcileFixture(db);
    const text = status(db, []);

    expect(text).toContain('2 sessions, 18 messages, 18 anchors (9 reconciled)');
    expect(text).toContain('1 cycle recorded, 1 reconciled');
    expect(text).toContain('Latest reconciled cycle: session fix-seven, cycle 0, 4 of 9 anchors dropped');
    expect(text).toContain('## Compact Instructions');
    expect(db.prepare("SELECT hits FROM telemetry WHERE cmd = 'status'").all()).toEqual([{ hits: 0 }]);
    db.close();
  });

  // The export travels to the maintainer, so the failure that matters is a leak: the seeded archive
  // carries CANARY-SEB-LEAK in every free-text column the schema has, and an exact comparison
  // against a hand-derived file fails if any of it reaches the output. The eval harness never
  // invokes the CLI, so nothing there can catch it.
  it('exports only counts, hashes and timestamps, never a byte of archived text', () => {
    const db = tempDb('seb-cli-report-');
    seedForReport(db);
    const parsed = JSON.parse(report(db, [])) as {
      schema: number;
      env: Record<string, string>;
      data: { totals: Record<string, number> };
    };

    // The archive's size on disk is not reproducible, so it is asserted rather than pinned.
    expect(parsed.data.totals.dbBytes).toBeGreaterThan(0);
    delete parsed.data.totals.dbBytes;

    expect(parsed.schema).toBe(1);
    expect(parsed.data).toEqual(JSON.parse(golden('report-data.json')));
    expect(parsed.env.project).toMatch(/^[0-9a-f]{12}$/);
    expect(report(db, [])).not.toContain(CANARY);
    db.close();
  });

  // A silently dead install is the failure the eval harness cannot see: it drives the hook bodies
  // directly, so it can never observe hooks that were never wired to fire. These two readings are
  // what a field tester checks after installing.
  it('distinguishes an install where no hook has ever fired from one where all three have', () => {
    const empty = tempDb('seb-cli-hooks-none-');
    expect(status(empty, [])).toContain('Hooks: none has run yet.');
    empty.close();

    const db = tempDb('seb-cli-hooks-all-');
    logEvent(db, 'pre-compact', 'info', 'archived 12 messages');
    logEvent(db, 'pre-compact', 'warn', 'no transcript to archive; steering only');
    logEvent(db, 'post-compact', 'info', 'cycle 0: 9 verdicts persisted');
    logEvent(db, 'session-start', 'info', 'cycle 0: reconciled index');
    const text = status(db, []);

    expect(text).toContain('Hooks: pre-compact 2 runs, post-compact 1 run, session-start 1 run;');
    expect(text).toContain('(1 warning — `seb report` has the detail)');
    db.close();
  });
});

// The CLI runs from a shell, so its exit code is the signal the model reads. Unlike a hook it may
// fail loudly — but only on conditions the caller can fix, and never with a stack trace on a
// project that has simply never compacted.
describe('cli process edge', () => {
  const HOME = tempDir('seb-cli-home-');
  const REAL_HOME = process.env.HOME;
  const REAL_CWD = process.cwd();

  beforeAll(() => {
    process.env.HOME = HOME;
  });

  afterAll(() => {
    process.env.HOME = REAL_HOME;
    process.chdir(REAL_CWD);
  });

  it('exits 0 with a note when the project has no archive yet, and 1 only for a mistake the caller can correct', async () => {
    const cwd = tempDir('seb-cli-cwd-');
    process.chdir(cwd);

    // Nothing has compacted here: an empty result would read as "nothing was ever archived".
    expect(await main(['status'])).toBe(0);
    expect(await main(['frobnicate'])).toBe(1);
    expect(await main([])).toBe(1);

    // macOS resolves the temporary directory through a symlink, so the slug has to come from the
    // working directory as the CLI itself reads it, not from the path mkdtemp returned.
    const db = openDb(projectSlug(process.cwd()));
    archiveFixture(db, FIXTURE);
    db.close();

    expect(await main(['timeline', '--cycle', '0'])).toBe(0);
    expect(await main(['search'])).toBe(1);
    expect(await main(['search', 'retry', '--type', 'nonsense'])).toBe(1);
    expect(await main(['show', 't99e1'])).toBe(1);
    expect(await main(['show', 'not-an-id'])).toBe(1);
    expect(await main(['index', '--nope'])).toBe(1);
  });
});

const CANARY = 'CANARY-SEB-LEAK';

// One archive with every shape the report reads: two sessions, a cycle whose SessionStart ran and
// spent tokens, one whose render was empty, one SessionStart never reached, both verdict bands, an
// unreconciled anchor, three hooks with one warning, and retrievals with and without hits. Written
// as direct SQL at fixed timestamps so the document is byte-stable, and every free-text column
// carries the canary.
function seedForReport(db: DatabaseSync): void {
  const messages = [
    ['u1', 's-alpha', 0, 1], ['u2', 's-alpha', 0, 2], ['u3', 's-alpha', 0, 3],
    ['u4', 's-alpha', 0, 4], ['u5', 's-beta', 0, 1],
  ] as const;
  const message = db.prepare(
    'INSERT INTO messages (uuid, session_id, cycle, turn, ts, role, record) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const [uuid, session, cycle, turn] of messages) {
    message.run(uuid, session, cycle, turn, '2026-09-01T10:00:00.000Z', 'user', `{"t":"${CANARY}"}`);
  }

  const anchors = [
    ['s-alpha', 't1e1', 'u1', 0, 1, 'error', 'dropped', 0.1],
    ['s-alpha', 't2e1', 'u2', 0, 2, 'error', 'dropped', 0.3],
    ['s-alpha', 't3d1', 'u3', 0, 3, 'edit', 'kept', 1],
    ['s-alpha', 't4a1', 'u4', 0, 4, 'answer', 'dropped', 0],
    ['s-beta', 't1e1', 'u5', 0, 1, 'error', null, null],
  ] as const;
  const anchor = db.prepare(
    'INSERT INTO anchors (session_id, id, uuid, cycle, turn, type, key, excerpt, verdict, score) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const [session, id, uuid, cycle, turn, type, verdict, score] of anchors) {
    anchor.run(session, id, uuid, cycle, turn, type, CANARY, CANARY, verdict, score);
  }

  const cycleRows = [
    ['s-alpha', 0, 'auto', '2026-09-01T11:00:00.000Z', 118],
    ['s-alpha', 1, 'manual', '2026-09-01T11:30:00.000Z', 0],
    ['s-beta', 0, 'auto', null, null],
  ] as const;
  const cycle = db.prepare(
    'INSERT INTO cycles (session_id, cycle, trigger, reconciled_at, summary, injected_tokens) ' +
      'VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const [session, n, trigger, reconciledAt, tokens] of cycleRows) {
    cycle.run(session, n, trigger, reconciledAt, CANARY, tokens);
  }

  const telemetry = [
    ['search', 'error', 3], ['search', 'error', 0], ['show', 'answer', 1], ['status', null, 0],
  ] as const;
  const row = db.prepare(
    'INSERT INTO telemetry (ts, cmd, anchor_type, session_id, anchor_id, hits, cycle) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const [cmd, type, hits] of telemetry) {
    row.run('2026-09-01T11:40:00.000Z', cmd, type, null, null, hits, 1);
  }

  const events = [
    ['pre-compact', 'info', '2026-09-01T10:00:00.000Z'],
    ['pre-compact', 'info', '2026-09-01T11:00:00.000Z'],
    ['pre-compact', 'warn', '2026-09-01T12:00:00.000Z'],
    ['post-compact', 'info', '2026-09-01T11:05:00.000Z'],
    ['session-start', 'info', '2026-09-01T11:06:00.000Z'],
  ] as const;
  const event = db.prepare('INSERT INTO log (ts, hook, level, msg) VALUES (?, ?, ?, ?)');
  for (const [hook, level, ts] of events) event.run(ts, hook, level, CANARY);
}
