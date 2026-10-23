import type { DatabaseSync } from 'node:sqlite';

// Copies the session of every message above the highest row `message_sessions` holds. On the first
// open this is the whole archive; afterwards it is the rows an older build archived without this
// table. Rowids only grow, because the archive is never vacuumed, so the rows above the mark are
// exactly the rows still missing. An archive with nothing missing pays two indexed lookups.
//
// The first fill reads through `messages_session_turn`, which carries every rowid and session id,
// instead of the wide `messages` rows: on a 2 GB archive that is about 1 s cold instead of about 4.
export function fillMessageSessions(db: DatabaseSync): void {
  const empty = db.prepare('SELECT 1 FROM message_sessions LIMIT 1').get() === undefined;
  const source = empty
    ? 'FROM messages INDEXED BY messages_session_turn ORDER BY rowid'
    : 'FROM messages WHERE rowid > (SELECT COALESCE(MAX(rowid), 0) FROM message_sessions)';
  db.exec(`INSERT INTO message_sessions (rowid, session_id) SELECT rowid, session_id ${source}`);
}
