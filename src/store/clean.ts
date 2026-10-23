import type { DatabaseSync } from 'node:sqlite';
import { parseLine } from '../transcript/parse.js';
import { isCompactEcho, messageText, sebCallIds } from '../transcript/text.js';

const MATCHED = 'FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid';

// Candidate lookups for the records that are dropped from the index whole. Each only narrows the
// scan, and a test on the parsed record decides. Every summary Claude Code has written opens with
// the phrase. The `/compact` echo is colour-coded, which glues an escape code onto its first word,
// so it is found by its stdout tag and the `seb` the steering block names.
const SUMMARY_PHRASE = '"continued from a previous conversation"';
const ECHO_CANDIDATE = '"local" "command" "stdout" "seb"';

// Every retrieval command runs through `seb` or through the plugin's `dist/index.js`, so a record
// that holds one holds one of these token sets. `sebCallIds` decides which calls really are one.
const SEB_CANDIDATE = '"seb" OR ("dist" "index" "js")';

// How far after a call its result can sit, as `seb show` pairs them: the records between carry no
// uuid and are not archived, and on the live archives every result sits within six archived turns.
const RESULT_REACH = 8;

type Reindex = (rowid: number, before: string, after: string) => void;

// Keeps compaction summaries, the `/compact` echo of the steering block, and Sebastian's own
// retrieval calls out of the message index, whoever wrote them. `user_version` holds the highest
// rowid already checked. Rowids only grow, because the archive is never vacuumed, so the rows above
// the mark are exactly the rows no clean has seen: an older build's hooks may have indexed them. An
// open that finds nothing new costs two lookups. The mark is a 32-bit integer, which holds about
// 2.1 billion rows.
export function cleanIndex(db: DatabaseSync): void {
  const mark = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  const top = Number(db.prepare('SELECT MAX(rowid) AS n FROM messages').get()?.n ?? 0);
  if (top <= mark) return;
  db.exec('BEGIN');
  try {
    const reindex = reindexer(db);
    unindexWhole(db, mark, reindex, SUMMARY_PHRASE, (r) => r.isCompactSummary === true);
    unindexWhole(db, mark, reindex, ECHO_CANDIDATE, isCompactEcho);
    unindexSebCalls(db, mark, reindex);
    db.exec(`PRAGMA user_version = ${Math.trunc(top)}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// An external-content index deletes an entry by the text it indexed, so the stored text is passed
// back before it is replaced. Archiving indexes every message, empty text included, and SQLite
// reports the archive as malformed when a message has no entry, so an emptied row is indexed too.
// The record itself is never touched.
function reindexer(db: DatabaseSync): Reindex {
  const unindex = db.prepare("INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', ?, ?)");
  const index = db.prepare('INSERT INTO messages_fts(rowid, text) VALUES (?, ?)');
  const update = db.prepare('UPDATE messages SET text = ? WHERE rowid = ?');
  return (rowid, before, after) => {
    if (before === after) return;
    unindex.run(rowid, before);
    update.run(after, rowid);
    index.run(rowid, after);
  };
}

function unindexWhole(
  db: DatabaseSync,
  mark: number,
  reindex: Reindex,
  candidate: string,
  test: (record: Record<string, unknown>) => boolean,
): void {
  const candidates = db.prepare(
    `SELECT m.rowid, m.text, m.record ${MATCHED} ` +
      "WHERE messages_fts MATCH ? AND messages_fts.rowid > ? AND m.role = 'user'",
  );
  for (const row of candidates.all(candidate, mark)) {
    const record = parseLine(row.record as string);
    if (record === null || !test(record)) continue;
    reindex(Number(row.rowid), String(row.text ?? ''), '');
  }
}

// A call and the results that answer it are recomputed together, because the result is a separate
// record that only the call's tool_use id links to.
function unindexSebCalls(db: DatabaseSync, mark: number, reindex: Reindex): void {
  const candidates = db.prepare(
    `SELECT m.session_id, m.turn, m.record ${MATCHED} ` +
      "WHERE messages_fts MATCH ? AND messages_fts.rowid > ? AND m.role = 'assistant'",
  );
  const reach = db.prepare(
    'SELECT rowid, text, record FROM messages WHERE session_id = ? AND turn BETWEEN ? AND ?',
  );
  for (const call of candidates.all(SEB_CANDIDATE, mark)) {
    const skip = sebCallIds([parseLine(call.record as string)]);
    if (skip.size === 0) continue;
    const turn = Number(call.turn);
    for (const row of reach.all(call.session_id as string, turn, turn + RESULT_REACH)) {
      const after = messageText(parseLine(row.record as string), skip);
      reindex(Number(row.rowid), String(row.text ?? ''), after);
    }
  }
}
