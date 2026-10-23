import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAnchors } from '../src/transcript/anchors.js';
import { parseTranscript } from '../src/transcript/parse.js';
import {
  archiveDelta, logTelemetry, messagesInRange, openDbAt, recordCycle, recordInjection, searchMessages,
} from '../src/store/db.js';
import { DatabaseSync } from 'node:sqlite';

const FIXTURE = fileURLToPath(new URL('./fixtures/seven-types.jsonl', import.meta.url));
const BOUNDARY = fileURLToPath(new URL('./fixtures/boundary.jsonl', import.meta.url));

const tempDb = (prefix: string) =>
  openDbAt(join(mkdtempSync(join(tmpdir(), prefix)), 'sebastian.db'));

function freshArchive() {
  const events = parseTranscript(FIXTURE);
  const anchors = extractAnchors(events);
  const db = tempDb('seb-store-');
  const counts = archiveDelta(db, events, anchors);
  return { db, events, anchors, counts };
}

// Round-trips against a real database file. The eval harness scores retrieval in aggregate; these
// pin the byte-level and row-level contracts it never asserts.

describe('store round-trip', () => {
  it('returns the archived JSONL line byte-identical after archive → search → position lookup, so retrieval never re-serializes a record', () => {
    const { db, events, anchors, counts } = freshArchive();
    expect(counts).toEqual({ messages: events.length, anchors: anchors.length });

    // "exponential" appears only in the user decision at line 8 of the fixture (turn 7).
    const hits = searchMessages(db, 'exponential backoff');
    expect(hits.map((h) => ({ turn: h.turn, anchors: h.anchors }))).toEqual([
      { turn: 7, anchors: [{ id: 't7u1', type: 'user' }] },
    ]);

    const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const hit = hits[0]!;
    expect(messagesInRange(db, hit.sessionId, hit.turn, hit.turn)[0]?.raw).toBe(lines[7]);
    expect(messagesInRange(db, hit.sessionId, 10_000, 10_000)).toEqual([]);
    db.close();
  });

  // Both narrowings degrade the same way when they break: to the unfiltered set, which reads as a
  // working search. SQLite treats a negative LIMIT as no limit at all, so a limit that arrives
  // from a command line is the clamp's problem, not SQLite's.
  it('narrows a multi-hit query by type and by limit, so neither `seb search --type` nor a negative `--limit` can silently return the unfiltered set', () => {
    const { db } = freshArchive();
    // "backoff" is in turns 1, 5 and 7; only turn 5 carries a url anchor.
    const urls = searchMessages(db, 'backoff', { type: 'url' });
    expect(urls.map((h) => ({ turn: h.turn, ids: h.anchors.map((a) => a.id) }))).toEqual([
      { turn: 5, ids: ['t5c1', 't5r1', 't5w1'] },
    ]);
    expect(searchMessages(db, 'backoff').length).toBeGreaterThan(1);
    expect(searchMessages(db, 'backoff', { limit: -1 })).toEqual([]);
    db.close();
  });

  // Archiving skips every key the session already holds before it inserts. The first five records
  // (turns 0 to 4) carry five of the nine anchors, so the full delta must still add the other four
  // records and four anchors, and a repeat of it must add nothing and change no byte.
  it('re-archiving a grown delta adds exactly the new rows and a repeat leaves every row byte-identical and the FTS index single-entry, so a refused compaction re-firing PreCompact cannot grow the archive', () => {
    const events = parseTranscript(FIXTURE);
    const anchors = extractAnchors(events);
    const db = tempDb('seb-rearchive-');
    expect(archiveDelta(db, events.slice(0, 5), anchors)).toEqual({ messages: 5, anchors: 5 });
    expect(archiveDelta(db, events, anchors)).toEqual({ messages: 4, anchors: 4 });
    const snapshot = () => ({
      messages: db.prepare('SELECT rowid, * FROM messages ORDER BY rowid').all(),
      anchors: db.prepare('SELECT rowid, * FROM anchors ORDER BY rowid').all(),
      sessions: db.prepare('SELECT rowid, session_id FROM message_sessions ORDER BY rowid').all(),
      index: db.prepare('SELECT id, block FROM messages_fts_data ORDER BY id').all(),
    });
    const before = snapshot();
    expect(before.sessions).toHaveLength(9);
    expect(archiveDelta(db, events, anchors)).toEqual({ messages: 0, anchors: 0 });
    expect(snapshot()).toEqual(before);

    // A double-fed external-content FTS index would return the same record twice.
    expect(searchMessages(db, 'exponential backoff')).toHaveLength(1);
    const rows = db
      .prepare('SELECT (SELECT count(*) FROM messages) AS m, (SELECT count(*) FROM anchors) AS a')
      .get();
    expect(rows).toEqual({ m: events.length, a: anchors.length });
    db.close();
  });

  // The test above cannot see this one: every record in seven-types.jsonl carries a uuid, so the
  // uuid-less skip never fires there. boundary.jsonl carries the service records that make the skip
  // load-bearing, and the FTS count is the half that matters — that is where the growth hides.
  it('archives no row for a record that carries no uuid, so re-firing PreCompact on a transcript of service records cannot grow the archive', () => {
    const events = parseTranscript(BOUNDARY);
    const anchors = extractAnchors(events);
    const archivable = events.filter((e) => e.uuid !== null).length;
    // Without uuid-less records in the fixture, nothing below can fail.
    expect(archivable).toBeLessThan(events.length);

    const db = tempDb('seb-nouuid-');
    expect(archiveDelta(db, events, anchors)).toEqual({
      messages: archivable,
      anchors: anchors.length,
    });
    expect(archiveDelta(db, events, anchors)).toEqual({ messages: 0, anchors: 0 });
    const rows = db
      .prepare('SELECT (SELECT count(*) FROM messages) AS m, (SELECT count(*) FROM messages_fts) AS f')
      .get();
    expect(rows).toEqual({ m: archivable, f: archivable });
    db.close();
  });

  // Anchor extraction needs the whole file for turn numbering and pending-question state, while a
  // hook archives a delta, so an anchor can name a message the delta leaves out — a mid-session
  // install is the plain case. The anchors carry a foreign key into messages, so the alternative to
  // skipping is a rollback that discards the whole compaction.
  it('skips an anchor whose message the delta leaves out, rather than rolling back every row in the delta', () => {
    const events = parseTranscript(FIXTURE);
    const anchors = extractAnchors(events);
    const orphaned = anchors[0]?.uuid;
    const delta = events.filter((e) => e.uuid !== orphaned);
    const db = tempDb('seb-orphan-');

    const counts = archiveDelta(db, delta, anchors);
    expect(counts).toEqual({
      messages: delta.length,
      anchors: anchors.filter((a) => a.uuid !== orphaned).length,
    });
    expect(searchMessages(db, 'exponential backoff')).toHaveLength(1);
    // "deadline" is in the held-back answer at turn 1 and nowhere else.
    expect(searchMessages(db, 'deadline', { type: 'answer' })).toEqual([]);

    // The skip is not a loss: the held-back message arriving later admits its anchors.
    expect(archiveDelta(db, events, anchors)).toEqual({ messages: 1, anchors: 2 });
    expect(searchMessages(db, 'deadline', { type: 'answer' })).toHaveLength(1);
    db.close();
  });

  // The archive stores whole transcripts verbatim, so its permissions are the only thing between a
  // shared machine and every prompt in the project. umask masks the mode mkdirSync asks for, and
  // SQLite creates the database file with the process umask applied to 0666 — 0644 under the
  // common default — so neither mode can be requested at creation and left at that.
  it('leaves the state directory at 0700 and the database file at 0600, so an archived transcript is never group- or world-readable', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'seb-modes-')), 'state', 'sebastian.db');
    const db = openDbAt(path);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    db.close();
  });

  // FTS5 reads a bare uppercase AND, OR, NOT or NEAR as a query operator, so a user's own words
  // reach MATCH as grammar: `AND backoff` raises `fts5: syntax error near "AND"` and the search
  // throws in the user's face. Reducing to letter-and-digit tokens does not help — the reduction
  // keeps those words intact — so quoting every token is what contains them.
  it('answers a query whose words are FTS5 operators, and one made only of punctuation, rather than raising a syntax error', () => {
    const { db } = freshArchive();
    // "and" is a real token of the user decision at line 8, so quoting makes this a two-word
    // search that matches; unquoted it is an operator with nothing on its left.
    expect(searchMessages(db, 'AND backoff').map((h) => h.turn)).toEqual([7]);
    expect(searchMessages(db, 'NEAR retry OR sync').map((h) => h.turn)).toEqual([]);
    expect(searchMessages(db, '--- :: ()')).toEqual([]);
    db.close();
  });

  // FTS5's tokenizer indexes non-ASCII content, so an ASCII-only query reduction archives an
  // accented or CJK term and then cannot reach it — a miss that looks identical to never having
  // archived it.
  it('matches an accented and a CJK term back out of the index, so a non-ASCII query returns hits rather than nothing', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u0',
      sessionId: 'unicode',
      timestamp: '2026-08-30T12:00:00.000Z',
      message: { role: 'user', content: 'Keep the café-menu cache and the 中文 fallback path.' },
    });
    const path = join(mkdtempSync(join(tmpdir(), 'seb-unicode-')), 'session.jsonl');
    writeFileSync(path, `${line}\n`);

    const events = parseTranscript(path);
    const db = tempDb('seb-unicode-db-');
    expect(archiveDelta(db, events, extractAnchors(events))).toEqual({ messages: 1, anchors: 1 });
    expect(searchMessages(db, 'café').map((h) => [h.sessionId, h.turn])).toEqual([['unicode', 0]]);
    expect(searchMessages(db, '中文').map((h) => [h.sessionId, h.turn])).toEqual([['unicode', 0]]);
    db.close();
  });

  // The two live archives were built when the message index covered the raw JSONL line and the
  // messages table had no text column. Opening one must move it to the text index without losing a
  // record, and a fact that exists only inside a tool result must then be reachable. The eval
  // harness builds every database fresh and never sees an archive from an earlier build.
  it('search reaches a tool result archived before the text column existed, by an inflected form of a word in it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'seb-text-migrate-')), 'sebastian.db');
    const probe = JSON.stringify({
      type: 'user', uuid: 'u5', sessionId: 'old-build', timestamp: '2026-09-02T08:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_p', content: 'NewSeqId Seq 2611\nDELETE 204' }],
      },
    });
    const ask = JSON.stringify({
      type: 'user', uuid: 'u4', sessionId: 'old-build', timestamp: '2026-09-02T07:59:00.000Z',
      message: { role: 'user', content: 'probe the write path and read the sequence back' },
    });
    const before = new DatabaseSync(path);
    before.exec(`
      CREATE TABLE messages (uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, cycle INTEGER NOT NULL,
        turn INTEGER NOT NULL, ts TEXT, role TEXT, record TEXT NOT NULL);
      CREATE VIRTUAL TABLE messages_fts USING fts5(record, content='messages', content_rowid='rowid');
      CREATE TABLE anchors (id TEXT NOT NULL, uuid TEXT NOT NULL, session_id TEXT NOT NULL, cycle INTEGER NOT NULL,
        turn INTEGER NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, excerpt TEXT NOT NULL, verdict TEXT, score REAL,
        PRIMARY KEY (session_id, id));
      CREATE VIRTUAL TABLE anchors_fts USING fts5(key, excerpt, content='anchors', content_rowid='rowid');
    `);
    const insert = before.prepare(
      'INSERT INTO messages (uuid, session_id, cycle, turn, ts, role, record) VALUES (?, ?, 0, ?, ?, ?, ?)',
    );
    const fts = before.prepare('INSERT INTO messages_fts (rowid, record) VALUES (?, ?)');
    for (const [uuid, turn, raw] of [['u4', 4, ask], ['u5', 5, probe]] as const) {
      const row = insert.run(uuid, 'old-build', turn, '2026-09-02T08:00:00.000Z', 'user', raw);
      fts.run(row.lastInsertRowid, raw);
    }
    before.close();

    const db = openDbAt(path);
    const hits = searchMessages(db, '2611');
    expect(hits.map((h) => [h.sessionId, h.turn])).toEqual([['old-build', 5]]);
    // The record says DELETE; the reader types the past tense. Stemming makes them one token.
    expect(searchMessages(db, 'deleted').map((h) => h.turn)).toEqual([5]);
    expect(messagesInRange(db, 'old-build', 5, 5).map((m) => m.raw)).toEqual([probe]);
    // The envelope is no longer indexed, so a field name matches nothing.
    expect(searchMessages(db, 'timestamp')).toEqual([]);
    // The anchor index an earlier build wrote is gone, shadow tables included.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'anchors_fts%'").all()).toEqual([]);
    db.close();
  });

  // An older build indexed every compaction summary and every `/compact` echo of the steering
  // block, and its hooks keep doing so after a newer `seb` is installed. Each summary opens with the
  // same platform sentence. The quote at turn 9 holds that sentence without being a summary, so it
  // proves the record's flag decides and the phrase only narrows the scan. The echo is colour-coded
  // as the platform writes it. An old archive and a stale writer are the same case: rows above the
  // mark. A new echo archived by this build never reaches the index at all.
  it('takes summaries and /compact echoes an older build indexed out of search at the next open, never indexes a new echo, and keeps their records byte-identical and a quote searchable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seb-summary-clean-'));
    const path = join(dir, 'sebastian.db');
    const opening = 'This session is being continued from a previous conversation that ran out of context.';
    const echoText =
      '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m\n' +
      '\u001b[2m- State once that dropped detail is searchable with `seb search <words>`. probe 4417\u001b[22m</local-command-stdout>';
    const summary = record('s1', 'user', `${opening} Summary: probe 2611.`, { isCompactSummary: true });
    const quote = record('q2', 'user', `Why does every summary say "${opening}"`);
    const echo = record('e3', 'user', echoText);
    const old = openDbAt(path);
    writeAsOlderBuild(old, [
      [8, summary, `${opening} Summary: probe 2611.`],
      [9, quote, `Why does every summary say "${opening}"`],
      [10, echo, echoText],
    ]);
    old.close();

    const db = openDbAt(path);
    expect(searchMessages(db, 'continued previous conversation').map((h) => h.turn)).toEqual([9]);
    expect(searchMessages(db, '2611')).toEqual([]);
    expect(searchMessages(db, '4417')).toEqual([]);
    expect(messagesInRange(db, 'old-build', 8, 10).map((m) => m.raw)).toEqual([summary, quote, echo]);
    expectIndexInStep(db);

    const fresh = record('e4', 'user', echoText.replace('4417', '5523'), { sessionId: 'new-build' });
    writeFileSync(join(dir, 'echo.jsonl'), `${fresh}\n`);
    const events = parseTranscript(join(dir, 'echo.jsonl'));
    archiveDelta(db, events, extractAnchors(events));
    expect(searchMessages(db, '5523')).toEqual([]);
    db.close();
  });

  // A model that searched the archive left its own command and the printed page in the transcript,
  // and both say the words it searched for. The call at turn 1 runs nothing but seb: a `cd`, a
  // quoted `|` that is not a pipe, `2>&1`, and a `head`. The call at turn 3 also runs an `rg` over
  // the source, so it and its result at turn 4 are real work and stay searchable, seb and all.
  it('never indexes a call that only runs seb, or its printed result, from this build or an older one, and keeps a call that also does real work searchable', () => {
    const lines = [
      record('u0', 'user', 'Why does the retry loop hang?', { sessionId: 'seb-self' }),
      record('a1', 'assistant', [bash('toolu_s', 'cd /repo && seb search "retry|hang" 2>&1 | head -5')], { sessionId: 'seb-self' }),
      record('u2', 'user', [result('toolu_s', '6 hits for "retry" in this session')], { sessionId: 'seb-self' }),
      record('a3', 'assistant', [bash('toolu_m', 'rg -n retry src; seb search retry')], { sessionId: 'seb-self' }),
      record('u4', 'user', [result('toolu_m', 'src/sync.ts:3: retry()')], { sessionId: 'seb-self' }),
    ];
    const dir = mkdtempSync(join(tmpdir(), 'seb-self-'));
    writeFileSync(join(dir, 'self.jsonl'), `${lines.join('\n')}\n`);
    const path = join(dir, 'sebastian.db');
    const db = openDbAt(path);
    const events = parseTranscript(join(dir, 'self.jsonl'));
    archiveDelta(db, events, extractAnchors(events));
    const retryTurns = (d: DatabaseSync): number[] => searchMessages(d, 'retry').map((h) => h.turn).sort((a, b) => a - b);
    expect(retryTurns(db)).toEqual([0, 3, 4]);
    expect(messagesInRange(db, 'seb-self', 1, 2).map((m) => m.raw)).toEqual(lines.slice(1, 3));

    // The same seb-only pair, written by an older build with its text indexed, is cleaned at the
    // next open, and the mixed call is left as it was.
    writeAsOlderBuild(db, [
      [11, lines[1]!.replace('"a1"', '"o1"'), 'cd /repo && seb search "retry|hang" 2>&1 | head -5'],
      [12, lines[2]!.replace('"u2"', '"o2"'), '6 hits for "retry" in this session'],
    ]);
    db.close();
    const reopened = openDbAt(path);
    expect(retryTurns(reopened)).toEqual([0, 3, 4]);
    expectIndexInStep(reopened);
    reopened.close();
  });
});

const bash = (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
const result = (id: string, content: string) => ({ type: 'tool_result', tool_use_id: id, content });

// SQLite's own check that the external-content index holds exactly one entry per message, with the
// text the message holds. Archiving indexes every message, empty text included, so a clean that
// drops an emptied row's entry leaves an archive SQLite reports as malformed.
function expectIndexInStep(db: DatabaseSync): void {
  expect(() => db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)")).not.toThrow();
}

// A transcript record in the shape Claude Code writes. Unset fields are dropped by JSON.stringify.
function record(
  uuid: string,
  role: 'user' | 'assistant',
  content: unknown,
  extra: { sessionId?: string; isCompactSummary?: boolean } = {},
): string {
  return JSON.stringify({
    type: role, uuid, sessionId: extra.sessionId ?? 'old-build', timestamp: '2026-09-02T08:00:00.000Z',
    isCompactSummary: extra.isCompactSummary, message: { role, content },
  });
}

// Rows as a build without the clean writes them: the record, its text, and an index entry for it.
function writeAsOlderBuild(db: DatabaseSync, rows: [turn: number, raw: string, text: string][]): void {
  const insert = db.prepare(
    'INSERT INTO messages (uuid, session_id, cycle, turn, ts, role, record, text) VALUES (?, ?, 0, ?, NULL, ?, ?, ?)',
  );
  const fts = db.prepare('INSERT INTO messages_fts (rowid, text) VALUES (?, ?)');
  for (const [turn, raw, text] of rows) {
    const r = JSON.parse(raw) as { uuid: string; sessionId: string; message: { role: string } };
    fts.run(insert.run(r.uuid, r.sessionId, turn, r.message.role, raw, text).lastInsertRowid, text);
  }
}

// A field tester who pulls a new build mid-test must keep the archive they have already produced.
// Their database was created without the columns the loop now writes, and `CREATE TABLE IF NOT
// EXISTS` cannot reach an existing table — so an unmigrated archive would take every later write
// down the hooks' fail-open path and record nothing, with no symptom until the export came back
// empty. The eval harness builds a fresh database for every case and can never see this.
describe('opening an archive built before the loop recorded cycles and injected tokens', () => {
  it('adds the missing columns and writes both without losing the rows already there', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'seb-migrate-')), 'sebastian.db');
    const before = new DatabaseSync(path);
    before.exec(`
      CREATE TABLE telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
        cmd TEXT NOT NULL, anchor_type TEXT, session_id TEXT, anchor_id TEXT, hits INTEGER);
      CREATE TABLE cycles (session_id TEXT NOT NULL, cycle INTEGER NOT NULL, trigger TEXT,
        archived_at TEXT, reconciled_at TEXT, summary TEXT, PRIMARY KEY (session_id, cycle));
    `);
    before.prepare('INSERT INTO telemetry (ts, cmd, hits) VALUES (?, ?, ?)')
      .run('2026-09-01T09:00:00.000Z', 'search', 4);
    before.close();

    const db = openDbAt(path);
    recordCycle(db, {
      sessionId: 'kept', cycle: 0, trigger: 'auto', summary: 'x', compactionMs: null,
      preTokens: null, postTokens: null, cumulativeDroppedTokens: null,
    });
    logTelemetry(db, { cmd: 'show', anchorType: 'error', hits: 1 });
    recordInjection(db, 'kept', 0, 118);

    expect(db.prepare('SELECT cmd, hits, cycle FROM telemetry ORDER BY id').all()).toEqual([
      { cmd: 'search', hits: 4, cycle: null },
      { cmd: 'show', hits: 1, cycle: 0 },
    ]);
    expect(db.prepare('SELECT injected_tokens FROM cycles').all()).toEqual([{ injected_tokens: 118 }]);
    db.close();

    // Opening again must be a no-op rather than a second ALTER.
    const reopened = openDbAt(path);
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM telemetry').get()).toEqual({ n: 2 });
    reopened.close();
  });
});
