#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { preCompact } from './hooks/preCompact.js';
import { postCompact } from './hooks/postCompact.js';
import { sessionStart } from './hooks/sessionStart.js';
import { readStdin, runHook, type HookBody } from './hooks/runHook.js';
import { dbPath, openDb, projectSlug } from './store/db.js';
import { UsageError } from './cli/args.js';
import { search } from './cli/search.js';
import { show } from './cli/show.js';
import { indexCommand } from './cli/index.js';
import { timeline } from './cli/timeline.js';
import { status } from './cli/status.js';
import { report } from './cli/report.js';

// The names hooks/run-hook.sh forwards, and the bodies they reach.
const BODIES: Record<string, HookBody> = {
  'pre-compact': preCompact,
  'post-compact': postCompact,
  'session-start': sessionStart,
};

// A command reads the project database and returns the text to print. Commands run from a shell,
// not from a hook, so they may exit non-zero — a mistyped flag or an id that is not archived is
// worth saying out loud.
type Command = (db: DatabaseSync, argv: string[]) => string;

const COMMANDS: Record<string, Command> = {
  search,
  show,
  index: indexCommand,
  timeline,
  status,
  report,
};

const USAGE = [
  'usage:',
  '  seb search <query> [--type error|answer|edit|user|cmd|read|url] [--cycle N] [--session ID] [--turn A:B] [--limit N]',
  '  seb show <anchor-id | cycle:turn> [--context N]',
  '  seb index [--dropped|--all|--raw]',
  '  seb timeline [--cycle N]',
  '  seb status',
  '  seb report',
  '  seb hook <pre-compact|post-compact|session-start>',
  '',
].join('\n');

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'hook') return Promise.resolve(dispatchHook(rest[0]));
  return Promise.resolve(runCommand(command, rest));
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

// The project database is resolved from the working directory, exactly as the hooks resolve it, so
// the CLI reads what the hooks wrote. An absent database is not an error: it is a project that has
// not compacted yet, and saying so is more use than an empty result or a stack trace.
function runCommand(name: string | undefined, argv: string[]): number {
  const run = name === undefined ? undefined : COMMANDS[name];
  if (run === undefined) {
    process.stderr.write(USAGE);
    return 1;
  }
  const slug = projectSlug(process.cwd());
  const path = dbPath(slug);
  if (!existsSync(path)) {
    process.stdout.write(`No archive for this project yet (${path}); it fills at the first compaction.\n`);
    return 0;
  }
  return runAgainst(slug, name ?? '', run, argv);
}

function runAgainst(slug: string, name: string, run: Command, argv: string[]): number {
  const db = openDb(slug);
  try {
    process.stdout.write(run(db, argv));
    return 0;
  } catch (err) {
    const reason = err instanceof UsageError ? err.message : String(err);
    process.stderr.write(`sebastian: ${name}: ${reason}\n`);
    return 1;
  } finally {
    db.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
