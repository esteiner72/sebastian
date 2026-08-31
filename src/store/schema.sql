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

CREATE TABLE IF NOT EXISTS cycles (
  session_id    TEXT NOT NULL,
  cycle         INTEGER NOT NULL,
  trigger       TEXT,
  archived_at   TEXT,
  reconciled_at TEXT,
  summary       TEXT,
  PRIMARY KEY (session_id, cycle)
);

CREATE TABLE IF NOT EXISTS telemetry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  cmd         TEXT NOT NULL,
  anchor_type TEXT,
  session_id  TEXT,                     -- with anchor_id, references anchors(session_id, id)
  anchor_id   TEXT,
  hits        INTEGER
);

CREATE TABLE IF NOT EXISTS log (        -- fail-open diagnostics; hooks never print to stdout
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, hook TEXT, level TEXT, msg TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS anchors_fts  USING fts5(key, excerpt, content='anchors',  content_rowid='rowid');
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(record,       content='messages', content_rowid='rowid');
