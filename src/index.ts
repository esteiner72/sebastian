#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { preCompact } from './hooks/preCompact.js';
import { postCompact } from './hooks/postCompact.js';
import { sessionStart } from './hooks/sessionStart.js';
import { userPromptSubmit } from './hooks/userPromptSubmit.js';
import { readStdin, runHook, type Hook } from './hooks/runHook.js';
import { dbPath, openDb, projectSlug, stampCommandMs } from './store/db.js';
import { UsageError } from './cli/args.js';
import { search } from './cli/search.js';
import { show } from './cli/show.js';
import { indexCommand } from './cli/index.js';
import { timeline } from './cli/timeline.js';
import { status } from './cli/status.js';
import { logCommand } from './cli/log.js';
import { report, reportAll } from './cli/report.js';
import { reconcileCommand } from './cli/reconcile.js';

// The names hooks/run-hook.sh forwards, the bodies they reach, and whether reaching one is allowed
// to create this project's archive. Only the two compaction hooks are.
export const HOOKS = {
  'pre-compact': { body: preCompact, creates: true },
  'post-compact': { body: postCompact, creates: true },
  'session-start': { body: sessionStart, creates: false },
  'user-prompt-submit': { body: userPromptSubmit, creates: false },
} satisfies Record<string, Hook>;

export type HookName = keyof typeof HOOKS;

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
  log: logCommand,
  report,
  reconcile: reconcileCommand,
};

const USAGE = [
  'usage:',
  '  seb search <query> [--type error|answer|edit|user|cmd|read|url] [--cycle N] [--session ID] [--turn A:B] [--limit N]',
  '  seb show <anchor-id | cycle:turn> [--context N]',
  '  seb index [--dropped|--all|--raw]',
  '  seb timeline [--cycle N]',
  '  seb status',
  '  seb log [--hook <name>] [--level info|warn|error] [--limit N]',
  '  seb report [--all]',
  '  seb reconcile',
  '  seb hook <pre-compact|post-compact|session-start|user-prompt-submit>',
  '',
].join('\n');

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'hook') return Promise.resolve(dispatchHook(rest[0]));
  // `report --all` reads the archive root, not the working directory, so it bypasses the project
  // resolution below — which would otherwise refuse from any directory that has never compacted.
  if (command === 'report' && rest.includes('--all')) {
    process.stdout.write(reportAll());
    return Promise.resolve(0);
  }
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
  const hook = Object.hasOwn(HOOKS, name) ? HOOKS[name as HookName] : undefined;
  if (hook === undefined) {
    process.stderr.write(`sebastian: unknown hook ${name}\n`);
    return 0;
  }
  const out = runHook(name, hook, readStdin());
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

// The command's own duration, measured around the whole invocation and stamped onto the telemetry
// rows this invocation wrote.
function runAgainst(slug: string, name: string, run: Command, argv: string[]): number {
  const db = openDb(slug);
  const started = performance.now();
  try {
    process.stdout.write(run(db, argv));
    stampCommandMs(db, Math.round(performance.now() - started));
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
