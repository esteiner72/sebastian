#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logEvent, openDb, projectSlug } from './store/db.js';

const HOOK_NAMES = new Set(['pre-compact', 'post-compact', 'session-start']);

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'hook') return Promise.resolve(runHook(rest[0]));
  process.stderr.write('usage: seb hook <pre-compact|post-compact|session-start>\n');
  return Promise.resolve(1);
}

// Hooks are fail-open by contract: never a non-zero exit, never a byte on stdout.
function runHook(name: string | undefined): number {
  try {
    if (name === undefined || !HOOK_NAMES.has(name)) return 0;
    const payload = readPayload();
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
    const db = openDb(projectSlug(cwd));
    logEvent(db, name, 'info', 'noop');
    db.close();
  } catch (err) {
    process.stderr.write(`sebastian: ${String(err)}\n`);
  }
  return 0;
}

function readPayload(): Record<string, unknown> {
  if (process.stdin.isTTY) return {};
  const raw = readFileSync(0, 'utf8');
  if (raw.trim() === '') return {};
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
