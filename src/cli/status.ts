import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  archiveBytes, databaseFile, hookStats, logTelemetry, newestReconciledCycle, pendingCount,
  storeStats, undeliveredCycles, type HookStat,
} from '../store/db.js';
import { computeSteering } from '../steer/adapt.js';
import { capOutput, OUTPUT_TOKENS, plural } from './output.js';
import { usageWrap } from './args.js';

// What the loop knows about this project: how much is archived, how much of it is reconciled, and
// the steering block the next compaction will print. Steering is the loop's only visible output at
// compaction time, so seeing it before a compaction is how a reader checks the loop is adapting.
export function status(db: DatabaseSync, argv: string[]): string {
  usageWrap(() => parseArgs({ args: argv, options: {} }));
  const stats = storeStats(db);
  const cycle = newestReconciledCycle(db);
  // A status listing retrieves no anchor, so it reports no hit — the steering multiplier counts
  // only searches and shows, and an inflated row here would be a lie in both places.
  logTelemetry(db, { cmd: 'status', hits: 0 });
  const file = databaseFile(db);
  const lines = [
    `## Sebastian — ${file} (${formatSize(archiveBytes(db))})`,
    `${plural(stats.sessions, 'session')}, ${plural(stats.messages, 'message')}, ` +
      `${plural(stats.anchors, 'anchor')} (${stats.reconciled} reconciled)`,
    `${plural(stats.cycles, 'cycle')} recorded, ${stats.reconciledCycles} reconciled`,
    ...healthLine(db),
    hooksLine(hookStats(db)),
    `Telemetry: ${stats.searches} searches, ${stats.shows} shows`,
    latestLine(cycle),
    '',
  ];
  return capOutput(`${lines.join('\n')}\n${computeSteering(db)}`, OUTPUT_TOKENS);
}

// Two conditions, each printed only while it holds, so neither can become permanent furniture.
function healthLine(db: DatabaseSync): string[] {
  return [...pendingLine(db), ...undeliveredLine(db)];
}

// A compaction waiting to be closed. The `pending` table empties as soon as one is.
function pendingLine(db: DatabaseSync): string[] {
  const waiting = pendingCount(db);
  if (waiting === 0) return [];
  return [`${plural(waiting, 'compaction')} not yet closed — run \`seb reconcile\` or compact again.`];
}

// A cycle that was judged but never delivered. The hooks that deliver run only when the platform
// invokes them, and a hook it stops invoking leaves no other trace than this.
function undeliveredLine(db: DatabaseSync): string[] {
  const n = undeliveredCycles(db);
  if (n === 0) return [];
  return [`${plural(n, 'reconciled cycle')} never reached a model — run \`seb index\` to read the newest.`];
}

function latestLine(cycle: ReturnType<typeof newestReconciledCycle>): string {
  if (cycle === null) return 'No reconciled cycle yet.';
  const dropped = cycle.verdicts.filter((v) => v.verdict === 'dropped').length;
  return (
    `Latest reconciled cycle: session ${cycle.sessionId}, cycle ${cycle.cycle}, ` +
    `${dropped} of ${cycle.verdicts.length} anchors dropped`
  );
}

// Whether the plugin is wired up at all. A fresh install that never fired looks exactly like a
// working install in every other line of this report, so the absence of a hook is stated rather
// than left to be inferred from zero counts elsewhere. Warnings are called out because a hook that
// fails open on every cycle otherwise reads as a hook that works.
function hooksLine(hooks: HookStat[]): string {
  if (hooks.length === 0) return 'Hooks: none has run yet.';
  const parts = hooks.map((h) => `${h.hook} ${plural(h.runs, 'run')}`);
  const warns = hooks.reduce((n, h) => n + h.warns, 0);
  const last = hooks.reduce<string | null>((newest, h) => later(newest, h.lastRun), null);
  const suffix = warns === 0 ? '' : ` (${plural(warns, 'warning')} — \`seb log\` has the detail)`;
  return `Hooks: ${parts.join(', ')}; last ran ${last ?? 'never'}${suffix}`;
}

function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
