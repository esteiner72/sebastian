import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Matches Claude Code's own project-directory slug: every non-alphanumeric byte becomes a dash.
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function dbPath(slug: string): string {
  return join(homedir(), '.claude', 'sebastian', slug, 'sebastian.db');
}

// Task 1 ships only the log table; Task 3 extends this into the full schema.
export function openDb(slug: string): DatabaseSync {
  const path = dbPath(slug);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    `CREATE TABLE IF NOT EXISTS log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, hook TEXT, level TEXT, msg TEXT
    );`,
  );
  return db;
}

export function logEvent(db: DatabaseSync, hook: string, level: string, msg: string): void {
  db.prepare('INSERT INTO log (ts, hook, level, msg) VALUES (?, ?, ?, ?)').run(
    new Date().toISOString(),
    hook,
    level,
    msg,
  );
}
