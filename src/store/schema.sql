-- One database per project. Executed in full on every open, so every statement is idempotent.
-- Both FTS tables are external-content over their base table's implicit rowid; rows are inserted
-- explicitly alongside the base insert, no triggers. Never VACUUM this database: the base tables
-- have TEXT primary keys, so their implicit rowids — which the FTS indexes key on — would be
-- renumbered.

-- One project directory maps to one database, so two sessions in the same directory share this
-- file. A zero busy timeout makes the first contended write fail instantly, including the write on
-- the fail-open diagnostic path. WAL lives in the database header and converts once; busy_timeout
-- is per-connection, so it is re-set on every open.
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS messages (   -- durability past cleanupPeriodDays; PK is the dedupe
  uuid       TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  cycle      INTEGER NOT NULL,
  turn       INTEGER NOT NULL,
  ts         TEXT,
  role       TEXT,
  record     TEXT NOT NULL              -- the original JSONL line, verbatim
);

CREATE TABLE IF NOT EXISTS anchors (
  id         TEXT NOT NULL,             -- session-local, t{turn}{typeLetter}{ordinal}
  uuid       TEXT NOT NULL REFERENCES messages(uuid),
  session_id TEXT NOT NULL,
  cycle      INTEGER NOT NULL,
  turn       INTEGER NOT NULL,
  type       TEXT NOT NULL,
  key        TEXT NOT NULL,
  excerpt    TEXT NOT NULL,
  verdict    TEXT,                      -- NULL until reconciled, then 'kept' | 'dropped'
  score      REAL,
  PRIMARY KEY (session_id, id)
);

-- `injected_tokens` is what injection has spent on this cycle: the Forgotten Index plus the
-- availability note on each resume. Zero means the cycle dropped nothing and the renderer produced
-- nothing; NULL means no injector ever reached it, so the two cases stay distinguishable.
-- `injected_at` is the separate question of whether the index has been delivered, which is what
-- stops SessionStart and UserPromptSubmit both spending the budget on the same cycle.
--
-- `reconciled_at` is set only once verdicts are in the database, never at the moment the row is
-- written, so it can be read as "this cycle's anchors have been judged".
--
-- `compaction_ms` is the platform's own reported duration, which makes Sebastian's share of a
-- compaction arithmetic rather than an argument. The three token columns are the platform's own
-- accounting under its own names: this cycle's loss is `pre_tokens - post_tokens`, while
-- `cumulative_dropped_tokens` is a session running total and is not this cycle's figure.
CREATE TABLE IF NOT EXISTS cycles (
  session_id      TEXT NOT NULL,
  cycle           INTEGER NOT NULL,
  trigger         TEXT,
  archived_at     TEXT,
  reconciled_at   TEXT,
  summary         TEXT,
  injected_tokens INTEGER,
  injected_at     TEXT,
  compaction_ms   INTEGER,
  pre_tokens      INTEGER,
  post_tokens     INTEGER,
  cumulative_dropped_tokens INTEGER,
  PRIMARY KEY (session_id, cycle)
);

-- `cycle` is an attribution, not a fact. A CLI invocation receives no session or cycle from its
-- caller, so the column holds the newest cycle recorded in the project when the command ran. A
-- retrieval follows the injection that prompted it within the same session, so this is right in the
-- ordinary case and wrong when two sessions in one project interleave across a compaction.
CREATE TABLE IF NOT EXISTS telemetry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  cmd         TEXT NOT NULL,
  anchor_type TEXT,
  session_id  TEXT,                     -- with anchor_id, references anchors(session_id, id)
  anchor_id   TEXT,
  hits        INTEGER,
  cycle       INTEGER,                  -- attributed, not observed; see above
  ms          INTEGER                   -- whole-invocation duration, stamped after the command returns
);

-- A compaction PostCompact could not close, handed to whichever hook next runs with the boundary on
-- disk. A row appears when PostCompact gives up and is deleted when the cycle is reconciled, so the
-- table is empty whenever the loop is up to date.
CREATE TABLE IF NOT EXISTS pending (
  session_id TEXT NOT NULL,
  cycle      INTEGER NOT NULL,
  ts         TEXT NOT NULL,
  PRIMARY KEY (session_id, cycle)
);

-- Fail-open diagnostics; hooks never print to stdout. `ms` is set on exactly one row per hook
-- invocation, the row runHook writes when the body returns or throws, so counting rows with an `ms`
-- counts invocations. A row a hook body writes carries its own message and leaves `ms` null.
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, hook TEXT, level TEXT, msg TEXT,
  ms INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS anchors_fts  USING fts5(key, excerpt, content='anchors',  content_rowid='rowid');
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(record,       content='messages', content_rowid='rowid');

-- Retrieval paths that no primary key serves. `messages` keys on uuid alone, so a turn lookup would
-- scan every archived record; the anchors primary key leads on session_id, so a bare id would scan
-- the whole table. Archives outlive transcript cleanup and accumulate every session of a project,
-- so these scans grow without bound.
CREATE INDEX IF NOT EXISTS messages_session_turn ON messages(session_id, turn);  -- seb show; also covers the distinct-session count
CREATE INDEX IF NOT EXISTS messages_cycle_turn   ON messages(cycle, turn);       -- seb show <cycle:turn>
CREATE INDEX IF NOT EXISTS anchors_id            ON anchors(id);                 -- seb show on an unqualified anchor id
CREATE INDEX IF NOT EXISTS anchors_session_cycle ON anchors(session_id, cycle, turn);  -- the injected index, in turn order
