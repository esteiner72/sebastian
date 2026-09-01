import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs';
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
  migrateColumns(db);
  chmodSync(path, 0o600);
  return db;
}

// Columns added to a table that already exists. `CREATE TABLE IF NOT EXISTS` is a no-op on an
// archive from an earlier build, so a new column reaches it only here — and an archive mid-field-test
// is data nobody can regenerate. SQLite has no ADD COLUMN IF NOT EXISTS, hence the pragma test.
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ['telemetry', 'cycle', 'INTEGER'],
  ['cycles', 'injected_tokens', 'INTEGER'],
];

export function migrateColumns(db: DatabaseSync): void {
  const present = db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?');
  for (const [table, column, type] of ADDED_COLUMNS) {
    if (present.get(table, column) === undefined) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
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

const FROM_MATCHED = 'FROM anchors_fts JOIN anchors a ON a.rowid = anchors_fts.rowid';

// One page of the match, ordered by FTS rank.
export function searchAnchors(db: DatabaseSync, query: string, filters: AnchorFilters = {}): Anchor[] {
  const matched = matchClause(query, filters);
  if (matched === null) return [];
  const sql =
    'SELECT a.id, a.uuid, a.session_id, a.cycle, a.turn, a.type, a.key, a.excerpt ' +
    `${FROM_MATCHED} ${matched.where} ORDER BY rank LIMIT ?`;
  return db.prepare(sql).all(...matched.params, clampLimit(filters.limit)).map(rowToAnchor);
}

// The size of the whole match, not of the page. `searchAnchors` returns at most `clampLimit` rows,
// and a page that cannot say how much it left behind reads as the whole archive.
export function countAnchors(db: DatabaseSync, query: string, filters: AnchorFilters = {}): number {
  const matched = matchClause(query, filters);
  if (matched === null) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n ${FROM_MATCHED} ${matched.where}`).get(...matched.params);
  return Number(row?.n ?? 0);
}

// The query is reduced to letter, digit and underscore tokens before it reaches MATCH, which drops
// FTS5's operator characters (dashes, colons, parentheses). Each surviving token is then quoted,
// because the reduction cannot drop the operator *words*: a bare AND, OR, NOT or NEAR is grammar to
// FTS5, and a user searching `AND backoff` would otherwise get a syntax error instead of rows.
// Quoted tokens combine as an implicit AND. The class is Unicode-aware because FTS5's unicode61
// tokenizer indexes non-ASCII content: an ASCII-only reduction turns an accented identifier or a
// CJK path into archived-but-unreachable text. Filters compile to plain WHERE clauses on the joined
// base table. A query with no surviving token matches nothing, which the callers read as null.
function matchClause(
  query: string,
  filters: AnchorFilters,
): { where: string; params: SQLInputValue[] } | null {
  const match = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((t) => `"${t}"`).join(' ');
  if (match === '') return null;
  let where = 'WHERE anchors_fts MATCH ?';
  const params: SQLInputValue[] = [match];
  if (filters.type !== undefined) { where += ' AND a.type = ?'; params.push(filters.type); }
  if (filters.cycle !== undefined) { where += ' AND a.cycle = ?'; params.push(filters.cycle); }
  if (filters.sessionId !== undefined) { where += ' AND a.session_id = ?'; params.push(filters.sessionId); }
  if (filters.turnRange !== undefined) {
    where += ' AND a.turn BETWEEN ? AND ?';
    params.push(filters.turnRange.from, filters.turnRange.to);
  }
  return { where, params };
}

// SQLite reads a negative LIMIT as no limit at all, so a limit that arrives from a command line is
// clamped rather than passed through.
export const MAX_LIMIT = 200;

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

// `seb show` resolves a session-local id against the whole project, because the display form the
// model copies back carries at most an 8-character session prefix — and that prefix is a display
// convenience, never a key, so it is matched as a prefix and an ambiguous match is the caller's to
// resolve.
export function lookupAnchors(db: DatabaseSync, id: string, sessionPrefix?: string): Anchor[] {
  const sql =
    'SELECT id, uuid, session_id, cycle, turn, type, key, excerpt FROM anchors WHERE id = ?' +
    (sessionPrefix === undefined ? '' : ' AND session_id LIKE ? ESCAPE \'\\\'') +
    ' ORDER BY session_id';
  const params: SQLInputValue[] = sessionPrefix === undefined ? [id] : [id, `${likePrefix(sessionPrefix)}%`];
  return db.prepare(sql).all(...params).map(rowToAnchor);
}

// The `cycle:turn` target names a position, and a position exists in every session that reached
// it, so the sessions holding one are what the caller needs to choose between.
export function sessionsAtTurn(
  db: DatabaseSync,
  cycle: number,
  turn: number,
  sessionPrefix?: string,
): string[] {
  const sql =
    'SELECT DISTINCT session_id FROM messages WHERE cycle = ? AND turn = ?' +
    (sessionPrefix === undefined ? '' : ' AND session_id LIKE ? ESCAPE \'\\\'') +
    ' ORDER BY session_id';
  const params: SQLInputValue[] =
    sessionPrefix === undefined ? [cycle, turn] : [cycle, turn, `${likePrefix(sessionPrefix)}%`];
  return db.prepare(sql).all(...params).map((row) => row.session_id as string);
}

// A session id is hexadecimal in practice, but the prefix arrives from a command line, so LIKE's
// own wildcards are escaped rather than trusted.
function likePrefix(prefix: string): string {
  return prefix.replaceAll(/[\\%_]/g, (c) => `\\${c}`);
}

// `--session` accepts what display prints, which is an 8-character prefix, so a prefix that the
// reader copied back resolves to the session it names instead of matching nothing.
export function sessionsMatching(db: DatabaseSync, prefix: string): string[] {
  return db
    .prepare("SELECT DISTINCT session_id FROM anchors WHERE session_id LIKE ? ESCAPE '\\' ORDER BY session_id")
    .all(`${likePrefix(prefix)}%`)
    .map((row) => row.session_id as string);
}

export interface ArchivedMessage {
  sessionId: string;
  turn: number;
  cycle: number;
  ts: string | null;
  role: string | null;
  raw: string;
}

// The `± N turns` window of `seb show`. Turns are file positions, so a contiguous range is a
// contiguous slice of the transcript, and a turn archived from a different delta is simply absent.
export function messagesInRange(
  db: DatabaseSync,
  sessionId: string,
  from: number,
  to: number,
): ArchivedMessage[] {
  return db
    .prepare(
      'SELECT session_id, turn, cycle, ts, role, record FROM messages ' +
        'WHERE session_id = ? AND turn BETWEEN ? AND ? ORDER BY turn',
    )
    .all(sessionId, from, to)
    .map((row) => ({
      sessionId: row.session_id as string,
      turn: Number(row.turn),
      cycle: Number(row.cycle),
      ts: (row.ts as string | null) ?? null,
      role: (row.role as string | null) ?? null,
      raw: row.record as string,
    }));
}

// The turn map behind `seb timeline`: every anchor, newest cycle first, in file order within a
// cycle. Insertion order breaks the tie inside a turn, which is extraction order, so a turn's
// anchors read in the order the transcript produced them.
export function listAnchors(db: DatabaseSync, cycle?: number): Anchor[] {
  const sql =
    'SELECT id, uuid, session_id, cycle, turn, type, key, excerpt FROM anchors' +
    (cycle === undefined ? '' : ' WHERE cycle = ?') +
    ' ORDER BY cycle DESC, session_id, turn, rowid';
  const params: SQLInputValue[] = cycle === undefined ? [] : [cycle];
  return db.prepare(sql).all(...params).map(rowToAnchor);
}

export interface StoreStats {
  sessions: number;
  messages: number;
  anchors: number;
  reconciled: number;
  cycles: number;
  reconciledCycles: number;
  searches: number;
  shows: number;
}

// One scalar per statistic, in one round trip: `seb status` reports the archive, not a sample of
// it, so every count here is over the whole project database.
export function storeStats(db: DatabaseSync): StoreStats {
  const row = db
    .prepare(
      'SELECT (SELECT COUNT(DISTINCT session_id) FROM messages) AS sessions, ' +
        '(SELECT COUNT(*) FROM messages) AS messages, ' +
        '(SELECT COUNT(*) FROM anchors) AS anchors, ' +
        '(SELECT COUNT(*) FROM anchors WHERE verdict IS NOT NULL) AS reconciled, ' +
        '(SELECT COUNT(*) FROM cycles) AS cycles, ' +
        '(SELECT COUNT(*) FROM cycles WHERE reconciled_at IS NOT NULL) AS reconciled_cycles, ' +
        "(SELECT COUNT(*) FROM telemetry WHERE cmd = 'search') AS searches, " +
        "(SELECT COUNT(*) FROM telemetry WHERE cmd = 'show') AS shows",
    )
    .get();
  return {
    sessions: Number(row?.sessions),
    messages: Number(row?.messages),
    anchors: Number(row?.anchors),
    reconciled: Number(row?.reconciled),
    cycles: Number(row?.cycles),
    reconciledCycles: Number(row?.reconciled_cycles),
    searches: Number(row?.searches),
    shows: Number(row?.shows),
  };
}

// SQLite knows where it opened from, so `seb status` reports the file in use rather than
// recomputing a path that a test — or a future flag — may have overridden.
export function databaseFile(db: DatabaseSync): string {
  const row = db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get();
  return (row?.file as string | undefined) ?? '';
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

export interface CycleIndex {
  sessionId: string;
  cycle: number;
  reconciled: boolean;
  anchors: Anchor[];
  verdicts: Verdict[];
}

// What SessionStart injects: the anchors of the session's latest cycle. A reconciled cycle carries
// a verdict per anchor; an unreconciled one carries the anchors alone, and the renderer labels
// them unchecked rather than dropped.
//
// The lookup is the session's newest cycle row or nothing. Falling back to an older cycle, or to
// another session in the same project database, would inject a stale index labelled as this
// cycle's — anchor ids are session-local, so its entries would not even address the right rows.
// Injection is per-session by contract; project scope belongs to `seb search`.
export function latestCycle(db: DatabaseSync, sessionId?: string | null): CycleIndex | null {
  if (sessionId === undefined || sessionId === null) return null;
  const row = db
    .prepare('SELECT session_id, cycle, reconciled_at FROM cycles WHERE session_id = ? ORDER BY cycle DESC LIMIT 1')
    .get(sessionId);
  if (row === undefined) return null;
  return loadCycle(db, row.session_id as string, Number(row.cycle), row.reconciled_at !== null);
}

// What `seb index` reports: the project's most recently reconciled cycle, whichever session it
// belongs to. The CLI runs from a shell and is never told the caller's session id, and the id it
// could guess would be the wrong one as often as not — so the CLI reads the project, the way
// `seb search` does, while injection stays per-session.
export function newestReconciledCycle(db: DatabaseSync): CycleIndex | null {
  const row = db
    .prepare(
      'SELECT session_id, cycle FROM cycles WHERE reconciled_at IS NOT NULL ' +
        'ORDER BY reconciled_at DESC, cycle DESC LIMIT 1',
    )
    .get();
  if (row === undefined) return null;
  return loadCycle(db, row.session_id as string, Number(row.cycle), true);
}

// A cycle holds either reconciled anchors or unreconciled ones, never a mixture: a verdict lands
// on every anchor of a cycle or on none of them.
function loadCycle(db: DatabaseSync, sessionId: string, cycle: number, reconciled: boolean): CycleIndex {
  const rows = db
    .prepare(
      'SELECT id, uuid, session_id, cycle, turn, type, key, excerpt, verdict, score FROM anchors ' +
        `WHERE session_id = ? AND cycle = ? AND verdict IS ${reconciled ? 'NOT NULL' : 'NULL'} ` +
        'ORDER BY turn, rowid',
    )
    .all(sessionId, cycle);
  return {
    sessionId,
    cycle,
    reconciled,
    anchors: rows.map(rowToAnchor),
    verdicts: reconciled ? rows.map(rowToVerdict) : [],
  };
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

// The cycle is resolved here rather than passed in: a command runs from a shell and is never told
// which cycle prompted it, so no caller could supply a better answer than the database already has.
export function logTelemetry(db: DatabaseSync, t: TelemetryEntry): void {
  db.prepare(
    'INSERT INTO telemetry (ts, cmd, anchor_type, session_id, anchor_id, hits, cycle) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    new Date().toISOString(),
    t.cmd,
    t.anchorType ?? null,
    t.sessionId ?? null,
    t.anchorId ?? null,
    t.hits,
    currentCycle(db),
  );
}

// The newest cycle recorded anywhere in the project, which is the one a retrieval most likely
// follows. Null before the first compaction, when a command can only be reaching the archive
// directly.
export function currentCycle(db: DatabaseSync): number | null {
  const row = db.prepare('SELECT MAX(cycle) AS cycle FROM cycles').get();
  return row?.cycle === null || row?.cycle === undefined ? null : Number(row.cycle);
}

// What SessionStart spent on this cycle's index. Written for every cycle the hook renders,
// including the zero case: a cycle that dropped nothing spent nothing, and NULL is reserved for a
// cycle SessionStart never reached.
export function recordInjection(db: DatabaseSync, sessionId: string, cycle: number, tokens: number): void {
  db.prepare('UPDATE cycles SET injected_tokens = ? WHERE session_id = ? AND cycle = ?').run(
    tokens,
    sessionId,
    cycle,
  );
}

export interface HookStat {
  hook: string;
  runs: number;
  warns: number;
  lastRun: string | null;
}

// Every hook logs a row on every path, so this table is also the install check: no row for a hook
// means that hook has never executed. Reads no `msg` — the text is a diagnostic that can quote a
// path or an error body, and nothing here needs it. Hooks are listed in the order they fire, not the
// order they logged, so a missing one reads as a gap.
const HOOK_ORDER = ['pre-compact', 'post-compact', 'session-start'];

export function hookStats(db: DatabaseSync): HookStat[] {
  const rows = db
    .prepare(
      "SELECT hook, COUNT(*) AS runs, SUM(level = 'warn') AS warns, MAX(ts) AS last_run " +
        'FROM log WHERE hook IS NOT NULL GROUP BY hook',
    )
    .all();
  const byHook = new Map(rows.map((r) => [String(r.hook), r]));
  return HOOK_ORDER.filter((hook) => byHook.has(hook)).map((hook) => {
    const row = byHook.get(hook);
    return {
      hook,
      runs: Number(row?.runs ?? 0),
      warns: Number(row?.warns ?? 0),
      lastRun: (row?.last_run as string | null) ?? null,
    };
  });
}

// The database plus its write-ahead log: the log holds committed rows that have not been
// checkpointed, so the main file alone understates a busy project.
export function archiveBytes(db: DatabaseSync): number {
  const file = databaseFile(db);
  return fileBytes(file) + fileBytes(`${file}-wal`);
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function logEvent(db: DatabaseSync, hook: string, level: string, msg: string): void {
  db.prepare('INSERT INTO log (ts, hook, level, msg) VALUES (?, ?, ?, ?)').run(
    new Date().toISOString(),
    hook,
    level,
    msg,
  );
}
