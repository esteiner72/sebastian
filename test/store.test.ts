import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAnchors } from '../src/transcript/anchors.js';
import { parseTranscript } from '../src/transcript/parse.js';
import { archiveDelta, getMessage, openDbAt, searchAnchors } from '../src/store/db.js';

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
  it('returns the archived JSONL line byte-identical after archive → search → uuid lookup, so retrieval never re-serializes a record', () => {
    const { db, events, anchors, counts } = freshArchive();
    expect(counts).toEqual({ messages: events.length, anchors: anchors.length });

    // "exponential" appears only in the user decision at line 8 of the fixture (uuid u7).
    const hits = searchAnchors(db, 'exponential backoff');
    expect(hits.map((a) => ({ id: a.id, type: a.type, uuid: a.uuid }))).toEqual([
      { id: 't7u1', type: 'user', uuid: 'u7' },
    ]);

    const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim() !== '');
    expect(getMessage(db, 'u7')?.raw).toBe(lines[7]);
    expect(getMessage(db, 'no-such-uuid')).toBeNull();
    db.close();
  });

  // Both narrowings degrade the same way when they break: to the unfiltered set, which reads as a
  // working search. SQLite treats a negative LIMIT as no limit at all, so a limit that arrives
  // from a command line is the clamp's problem, not SQLite's.
  it('narrows a multi-hit query by type and by limit, so neither `seb search --type` nor a negative `--limit` can silently return the unfiltered set', () => {
    const { db } = freshArchive();
    const urls = searchAnchors(db, 'backoff', { type: 'url' });
    expect(urls.map((a) => ({ type: a.type, key: a.key }))).toEqual([
      { type: 'url', key: 'https://example.com/docs/backoff' },
    ]);
    expect(searchAnchors(db, 'backoff').length).toBeGreaterThan(1);
    expect(searchAnchors(db, 'backoff', { limit: -1 })).toEqual([]);
    db.close();
  });

  it('re-archiving the same delta adds zero rows and leaves the FTS index single-entry, so a refused compaction re-firing PreCompact cannot grow the archive', () => {
    const { db, events, anchors } = freshArchive();
    expect(archiveDelta(db, events, anchors)).toEqual({ messages: 0, anchors: 0 });

    // A double-fed external-content FTS index would return the same anchor twice.
    expect(searchAnchors(db, 'exponential backoff')).toHaveLength(1);
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
    expect(searchAnchors(db, 'exponential backoff')).toHaveLength(1);
    expect(searchAnchors(db, 'timeout', { type: 'answer' })).toEqual([]);

    // The skip is not a loss: the held-back message arriving later admits its anchors.
    expect(archiveDelta(db, events, anchors)).toEqual({ messages: 1, anchors: 2 });
    expect(searchAnchors(db, 'timeout', { type: 'answer' })).toHaveLength(1);
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
    expect(searchAnchors(db, 'café').map((a) => a.uuid)).toEqual(['u0']);
    expect(searchAnchors(db, '中文').map((a) => a.uuid)).toEqual(['u0']);
    db.close();
  });
});
