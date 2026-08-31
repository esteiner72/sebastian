#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { preCompact } from './hooks/preCompact.js';
import { postCompact } from './hooks/postCompact.js';
import { sessionStart } from './hooks/sessionStart.js';
import { readStdin, runHook, type HookBody } from './hooks/runHook.js';

// The names hooks/run-hook.sh forwards, and the bodies they reach.
const BODIES: Record<string, HookBody> = {
  'pre-compact': preCompact,
  'post-compact': postCompact,
  'session-start': sessionStart,
};

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'hook') return Promise.resolve(dispatchHook(rest[0]));
  process.stderr.write('usage: seb hook <pre-compact|post-compact|session-start>\n');
  return Promise.resolve(1);
}

// The thin edge of the fail-open contract: runHook never throws, so the exit code is always 0, and
// stdout is written exactly once or not at all. That single write is a protocol channel —
// PreCompact's stdout becomes the compact instructions, SessionStart's becomes injected context —
// so every diagnostic goes to stderr and the log table instead.
function dispatchHook(name: string | undefined): number {
  if (name === undefined) {
    process.stderr.write('sebastian: hook requires a name\n');
    return 0;
  }
  const body = BODIES[name];
  if (body === undefined) {
    process.stderr.write(`sebastian: unknown hook ${name}\n`);
    return 0;
  }
  const out = runHook(name, body, readStdin());
  if (out !== '') process.stdout.write(out);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
