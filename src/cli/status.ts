import { parseArgs } from 'node:util';
import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { databaseFile, logTelemetry, newestReconciledCycle, storeStats } from '../store/db.js';
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
    `## Sebastian — ${file} (${formatSize(archiveSize(file))})`,
    `${plural(stats.sessions, 'session')}, ${plural(stats.messages, 'message')}, ` +
      `${plural(stats.anchors, 'anchor')} (${stats.reconciled} reconciled)`,
    `${plural(stats.cycles, 'cycle')} recorded, ${stats.reconciledCycles} reconciled`,
    `Telemetry: ${stats.searches} searches, ${stats.shows} shows`,
    latestLine(cycle),
    '',
  ];
  return capOutput(`${lines.join('\n')}\n${computeSteering(db)}`, OUTPUT_TOKENS);
}

function latestLine(cycle: ReturnType<typeof newestReconciledCycle>): string {
  if (cycle === null) return 'No reconciled cycle yet.';
  const dropped = cycle.verdicts.filter((v) => v.verdict === 'dropped').length;
  return (
    `Latest reconciled cycle: session ${cycle.sessionId}, cycle ${cycle.cycle}, ` +
    `${dropped} of ${cycle.verdicts.length} anchors dropped`
  );
}

// The write-ahead log holds committed rows that have not been checkpointed, so an archive's size
// is the database plus its log — reporting the main file alone understates a busy project.
function archiveSize(file: string): number {
  return fileSize(file) + fileSize(`${file}-wal`);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
