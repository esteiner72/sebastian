import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { logEvent, openDb, projectSlug } from '../store/db.js';
import { str } from '../transcript/text.js';

export type Payload = Record<string, unknown>;

// A hook body returns the text for stdout, or the empty string for nothing. It receives an open
// database and the parsed payload, and it may throw: runHook is the only place that catches.
export type HookBody = (db: DatabaseSync, payload: Payload) => string;

// The payload arrives on stdin. A read failure is indistinguishable from an empty payload here, so
// it degrades to empty text on stderr rather than escaping into the hook and costing exit 0.
export function readStdin(): string {
  try {
    if (process.stdin.isTTY === true) return '';
    return readFileSync(0, 'utf8');
  } catch (err) {
    process.stderr.write(`sebastian: stdin unreadable: ${String(err)}\n`);
    return '';
  }
}

// Fail-open, by contract with every hook event Sebastian registers: catch everything, return the
// empty string, and let the caller exit 0. Nothing here throws, so no hook can break compaction.
// Timing rides here rather than in the bodies, because this is the only place that sees a whole
// invocation including the database open and the failure path. Exactly one row per invocation
// carries an `ms`, which is what makes counting them equal to counting invocations.
export function runHook(name: string, body: HookBody, stdin: string): string {
  const started = performance.now();
  let payload: Payload = {};
  let db: DatabaseSync | null = null;
  try {
    payload = parsePayload(stdin);
    db = openDb(projectSlug(str(payload.cwd) ?? process.cwd()));
    const out = body(db, payload);
    logEvent(db, name, 'info', 'complete', elapsed(started));
    return out;
  } catch (err) {
    return reportFailure(name, payload, db, err, elapsed(started));
  } finally {
    closeQuietly(db);
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

// The diagnostic write shares every failure mode with the write it reports — a locked, missing, or
// read-only database — so it is best-effort, and stderr carries the reason either way. Diagnostics
// never touch stdout: for PreCompact and SessionStart that channel is a protocol.
function reportFailure(
  name: string, payload: Payload, db: DatabaseSync | null, err: unknown, ms: number,
): string {
  process.stderr.write(`sebastian: ${name}: ${String(err)}\n`);
  try {
    const target = db ?? openDb(projectSlug(str(payload.cwd) ?? process.cwd()));
    logEvent(target, name, 'error', String(err), ms);
    if (target !== db) target.close();
  } catch (logErr) {
    process.stderr.write(`sebastian: ${name}: log write failed: ${String(logErr)}\n`);
  }
  return '';
}

function closeQuietly(db: DatabaseSync | null): void {
  try {
    db?.close();
  } catch (err) {
    process.stderr.write(`sebastian: close failed: ${String(err)}\n`);
  }
}

function parsePayload(stdin: string): Payload {
  if (stdin.trim() === '') return {};
  const parsed: unknown = JSON.parse(stdin);
  return typeof parsed === 'object' && parsed !== null ? (parsed as Payload) : {};
}

// Two sources disagree on the field name — a live probe recorded `trigger`, the hook reference
// documents `compaction_trigger` — so both are read and neither is assumed.
export function hookTrigger(payload: Payload): string | null {
  return str(payload.trigger) ?? str(payload.compaction_trigger);
}

// Known bug #13668: `transcript_path` arrives empty. The fallback is the newest file named for the
// session id under any project directory, because a session that resumes in another directory
// keeps its id. No file anywhere means the caller no-ops.
export function resolveTranscript(payload: Payload): string | null {
  const declared = str(payload.transcript_path);
  if (declared !== null && declared !== '' && existsSync(declared)) return declared;
  const session = str(payload.session_id);
  if (session === null || session === '') return null;
  return newestSessionFile(session);
}

function newestSessionFile(sessionId: string): string | null {
  const root = join(homedir(), '.claude', 'projects');
  let best: { path: string; mtimeMs: number } | null = null;
  for (const entry of listDir(root)) {
    const path = join(root, entry, `${sessionId}.jsonl`);
    const mtimeMs = mtimeOf(path);
    if (mtimeMs !== null && (best === null || mtimeMs > best.mtimeMs)) best = { path, mtimeMs };
  }
  return best?.path ?? null;
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
