import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { toEvent, type TranscriptEvent } from '../transcript/parse.js';
import type { Anchor, AnchorType } from '../transcript/anchors.js';
import type { Verdict } from '../reconcile/reconcile.js';

// Matches Claude Code's own project-directory slug: every non-alphanumeric byte becomes a dash.
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function dbPath(slug: string): string {
  return join(homedir(), '.claude', 'sebastian', slug, 'sebastian.db');
}

export function openDb(slug: string): DatabaseSync {
  return openDbAt(dbPath(slug));
}

// The schema file ships beside the compiled module — the build copies it into dist/store — and
// every statement in it is idempotent, so opening is also migrating.
//
// The archive holds raw transcripts, so it is owner-only, matching the 0700 that Claude Code gives
// its own transcript store. The directory mode is the control that matters: WAL's -wal and -shm
// sidecars are created with the process umask, and umask also masks the mode passed to mkdirSync,
// so both modes are set explicitly rather than requested at creation.
export function openDbAt(path: string): DatabaseSync {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  chmodSync(path, 0o600);
  return db;
}

interface ArchiveStatements {
  message: ReturnType<DatabaseSync['prepare']>;
  messageFts: ReturnType<DatabaseSync['prepare']>;
  anchor: ReturnType<DatabaseSync['prepare']>;
  anchorFts: ReturnType<DatabaseSync['prepare']>;
}

// One transaction per delta. Message dedupe rides the uuid primary key, anchor dedupe rides
// (session_id, id), both via INSERT OR IGNORE. An FTS row is written only when its base insert
// actually added a row and is keyed on that row's rowid, so re-archiving the same delta touches
// neither index. Messages go first: anchors carry a foreign key into them.
//
// The two lists are derived independently — anchor extraction needs whole-file context for turn
// numbering and pending-question state, while a hook archives only a delta — so an anchor can name
// a message that is neither in this delta nor already archived. Such an anchor is skipped and
// counted out of the return value, because the foreign key would otherwise roll the whole delta
// back and lose one compaction's archive entirely.
export function archiveDelta(
  db: DatabaseSync,
  events: TranscriptEvent[],
  anchors: Anchor[],
): { messages: number; anchors: number } {
  const stmts: ArchiveStatements = {
    message: db.prepare(
      'INSERT OR IGNORE INTO messages (uuid, session_id, cycle, turn, ts, role, record) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    messageFts: db.prepare('INSERT INTO messages_fts (rowid, record) VALUES (?, ?)'),
    anchor: db.prepare(
      'INSERT OR IGNORE INTO anchors (id, uuid, session_id, cycle, turn, type, key, excerpt) ' +
        'SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE uuid = ?)',
    ),
    anchorFts: db.prepare('INSERT INTO anchors_fts (rowid, key, excerpt) VALUES (?, ?, ?)'),
  };
  db.exec('BEGIN');
  try {
    const counts = {
      messages: events.reduce((n, e) => n + insertMessage(stmts, e), 0),
      anchors: anchors.reduce((n, a) => n + insertAnchor(stmts, a), 0),
    };
    db.exec('COMMIT');
    return counts;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Service records — mode, last-prompt, atis-latch, file-history-snapshot and their kin — carry no
// uuid at all, and they are roughly a quarter of the records in a real transcript. Such a record
// can be neither deduped nor retrieved, so it is skipped rather than stored unreachable: SQLite
// accepts unlimited NULLs in a TEXT primary key, so storing them would append the whole population
// again on every re-archive, to the base table and to the FTS index alike. A crash-torn line also
// parses without a uuid, and takes the same path.
function insertMessage(stmts: ArchiveStatements, e: TranscriptEvent): number {
  if (e.uuid === null) return 0;
  const result = stmts.message.run(e.uuid, e.sessionId ?? '', e.cycle, e.turn, e.ts, e.role, e.raw);
  if (result.changes === 0) return 0;
  stmts.messageFts.run(result.lastInsertRowid, e.raw);
  return 1;
}

function insertAnchor(stmts: ArchiveStatements, a: Anchor): number {
  const result = stmts.anchor.run(
    a.id, a.uuid, a.sessionId, a.cycle, a.turn, a.type, a.key, a.excerpt, a.uuid,
  );
  if (result.changes === 0) return 0;
  stmts.anchorFts.run(result.lastInsertRowid, a.key, a.excerpt);
  return 1;
}

export interface AnchorFilters {
  type?: AnchorType;
  cycle?: number;
  sessionId?: string;
  turnRange?: { from: number; to: number };
  limit?: number;
}

// The query is reduced to letter, digit and underscore tokens before it reaches MATCH, which drops
// FTS5's operator characters (dashes, colons, parentheses). Each surviving token is then quoted,
// because the reduction cannot drop the operator *words*: a bare AND, OR, NOT or NEAR is grammar to
// FTS5, and a user searching `AND backoff` would otherwise get a syntax error instead of rows.
// Quoted tokens combine as an implicit AND. The class is Unicode-aware because FTS5's unicode61
// tokenizer indexes non-ASCII content: an ASCII-only reduction turns an accented identifier or a
// CJK path into archived-but-unreachable text. Filters compile to plain WHERE clauses on the joined
// base table.
export function searchAnchors(db: DatabaseSync, query: string, filters: AnchorFilters = {}): Anchor[] {
  const match = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((t) => `"${t}"`).join(' ');
  if (match === '') return [];
  let sql =
    'SELECT a.id, a.uuid, a.session_id, a.cycle, a.turn, a.type, a.key, a.excerpt ' +
    'FROM anchors_fts JOIN anchors a ON a.rowid = anchors_fts.rowid WHERE anchors_fts MATCH ?';
  const params: SQLInputValue[] = [match];
  if (filters.type !== undefined) { sql += ' AND a.type = ?'; params.push(filters.type); }
  if (filters.cycle !== undefined) { sql += ' AND a.cycle = ?'; params.push(filters.cycle); }
  if (filters.sessionId !== undefined) { sql += ' AND a.session_id = ?'; params.push(filters.sessionId); }
  if (filters.turnRange !== undefined) {
    sql += ' AND a.turn BETWEEN ? AND ?';
    params.push(filters.turnRange.from, filters.turnRange.to);
  }
  sql += ' ORDER BY rank LIMIT ?';
  params.push(clampLimit(filters.limit));
  return db.prepare(sql).all(...params).map(rowToAnchor);
}

// SQLite reads a negative LIMIT as no limit at all, so a limit that arrives from a command line is
// clamped rather than passed through.
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  return Math.min(Math.max(Math.trunc(limit), 0), MAX_LIMIT);
}

function rowToAnchor(row: Record<string, unknown>): Anchor {
  return {
    id: row.id as string,
    uuid: row.uuid as string,
    sessionId: row.session_id as string,
    cycle: Number(row.cycle),
    turn: Number(row.turn),
    type: row.type as AnchorType,
    key: row.key as string,
    excerpt: row.excerpt as string,
  };
}

// Re-hydrates the archived line through the same parser that produced it, with the stored turn
// and cycle, so a retrieved event is indistinguishable from one read off the live transcript.
export function getMessage(db: DatabaseSync, uuid: string): TranscriptEvent | null {
  const row = db.prepare('SELECT cycle, turn, record FROM messages WHERE uuid = ?').get(uuid);
  if (row === undefined) return null;
  return toEvent(Number(row.turn), Number(row.cycle), row.record as string);
}

export interface CycleRecord {
  sessionId: string;
  cycle: number;
  trigger: string | null;
  summary: string | null;
}

// PostCompact is the only writer of cycles rows, and it writes after reconciling — hence the
// reconcile timestamp lands here. A cycle whose summary never reached us is recorded all the same,
// because the compaction happened, but it stays unstamped: no summary means no verdicts, and a
// timestamp would claim a reconciliation that never ran. OR REPLACE makes a re-fired hook
// idempotent.
export function recordCycle(db: DatabaseSync, c: CycleRecord): void {
  const reconciledAt = c.summary === null ? null : new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO cycles (session_id, cycle, trigger, summary, reconciled_at) VALUES (?, ?, ?, ?, ?)',
  ).run(c.sessionId, c.cycle, c.trigger, c.summary, reconciledAt);
}

// One verdict per anchor, in one transaction: a half-written cycle would feed drop-rate a
// population that never existed. A verdict whose anchor is absent — its message was outside the
// archived delta, so the anchor insert was skipped — updates nothing and is counted out of the
// return value.
export function persistVerdicts(db: DatabaseSync, verdicts: Verdict[]): number {
  const stmt = db.prepare('UPDATE anchors SET verdict = ?, score = ? WHERE session_id = ? AND id = ?');
  db.exec('BEGIN');
  try {
    const updated = verdicts.reduce(
      (n, v) => n + Number(stmt.run(v.verdict, v.score, v.sessionId, v.anchorId).changes),
      0,
    );
    db.exec('COMMIT');
    return updated;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface ReconciledCycle {
  sessionId: string;
  cycle: number;
  anchors: Anchor[];
  verdicts: Verdict[];
}

// What SessionStart injects: the anchors of the session's latest cycle, with their verdicts.
// Anchors still carrying a NULL verdict are excluded, so an unreconciled cycle reads as empty
// rather than as a cycle that dropped nothing.
//
// The lookup is the session's newest cycle row or nothing. Falling back to an older reconciled
// cycle, or to another session in the same project database, would inject a stale index labelled
// as this cycle's — anchor ids are session-local, so its entries would not even address the right
// rows. Injection is per-session by contract; project scope belongs to `seb search`.
export function latestReconciledCycle(db: DatabaseSync, sessionId?: string | null): ReconciledCycle | null {
  const row = pickCycle(db, sessionId);
  if (row === null) return null;
  const rows = db
    .prepare(
      'SELECT id, uuid, session_id, cycle, turn, type, key, excerpt, verdict, score FROM anchors ' +
        'WHERE session_id = ? AND cycle = ? AND verdict IS NOT NULL ORDER BY turn',
    )
    .all(row.sessionId, row.cycle);
  return {
    sessionId: row.sessionId,
    cycle: row.cycle,
    anchors: rows.map(rowToAnchor),
    verdicts: rows.map(rowToVerdict),
  };
}

function pickCycle(db: DatabaseSync, sessionId?: string | null): { sessionId: string; cycle: number } | null {
  if (sessionId === undefined || sessionId === null) return null;
  const row = db
    .prepare('SELECT session_id, cycle, reconciled_at FROM cycles WHERE session_id = ? ORDER BY cycle DESC LIMIT 1')
    .get(sessionId);
  if (row === undefined || row.reconciled_at === null) return null;
  return { sessionId: row.session_id as string, cycle: Number(row.cycle) };
}

function rowToVerdict(row: Record<string, unknown>): Verdict {
  return {
    anchorId: row.id as string,
    sessionId: row.session_id as string,
    verdict: row.verdict === 'kept' ? 'kept' : 'dropped',
    score: Number(row.score),
  };
}

export interface TelemetryEntry {
  cmd: string;
  anchorType?: string;
  sessionId?: string;
  anchorId?: string;
  hits: number;
}

export function logTelemetry(db: DatabaseSync, t: TelemetryEntry): void {
  db.prepare(
    'INSERT INTO telemetry (ts, cmd, anchor_type, session_id, anchor_id, hits) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(new Date().toISOString(), t.cmd, t.anchorType ?? null, t.sessionId ?? null, t.anchorId ?? null, t.hits);
}

export function logEvent(db: DatabaseSync, hook: string, level: string, msg: string): void {
  db.prepare('INSERT INTO log (ts, hook, level, msg) VALUES (?, ?, ?, ?)').run(
    new Date().toISOString(),
    hook,
    level,
    msg,
  );
}
