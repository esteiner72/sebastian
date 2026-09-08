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

  it('re-archiving the same delta adds zero rows and leaves the FTS index single-entry, so a refused compaction re-firing PreCompact cannot grow the archive', () => {
    const { db, events, anchors } = freshArchive();
    expect(archiveDelta(db, events, anchors)).toEqual({ messages: 0, anchors: 0 });

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
        turn INTEGER NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, excerpt TEXT NOT NULL, PRIMARY KEY (session_id, id));
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
});

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
