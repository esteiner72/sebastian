import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { countLog, logTelemetry, recentLog, type LogFilters, type LogRow } from '../store/db.js';
import { integer, UsageError, usageWrap } from './args.js';
import { capOutput, OUTPUT_TOKENS } from './output.js';

const LEVELS = ['info', 'warn', 'error'];
const HINT = 'a lower --limit or a --hook';

// The loop's own record: one row per hook invocation plus whatever each body reported, printed in
// the order it happened. This is how a reader answers "did the loop close on that compaction?"
// without opening the database. It retrieves no anchor, so it reports no hit.
export function logCommand(db: DatabaseSync, argv: string[]): string {
  const filters = parseLog(argv);
  const rows = recentLog(db, filters);
  const matching = countLog(db, filters);
  logTelemetry(db, { cmd: 'log', hits: 0 });
  return `${heading(rows.length, matching, filters)}\n${capOutput(render(rows), OUTPUT_TOKENS, HINT)}`;
}

function parseLog(argv: string[]): LogFilters {
  const { values } = usageWrap(() =>
    parseArgs({
      args: argv,
      options: {
        hook: { type: 'string' },
        level: { type: 'string' },
        limit: { type: 'string' },
      },
    }),
  );
  return { hook: values.hook, level: levelOf(values.level), limit: limitOf(values.limit) };
}

function levelOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!LEVELS.includes(value)) throw new UsageError(`--level takes ${LEVELS.join('|')}, got "${value}"`);
  return value;
}

// A zero or negative limit reaches the store as `LIMIT 0`, which returns nothing and would read as
// an empty log.
function limitOf(value: string | undefined): number | undefined {
  const limit = integer(value, '--limit');
  if (limit !== undefined && limit < 1) {
    throw new UsageError('--limit takes a whole number of results, at least 1');
  }
  return limit;
}

// The heading states the page against the whole match, and names the filters that shaped it, so a
// short listing is never read as a quiet loop.
function heading(printed: number, matching: number, filters: LogFilters): string {
  const parts: string[] = [];
  if (filters.hook !== undefined) parts.push(`hook ${filters.hook}`);
  if (filters.level !== undefined) parts.push(`level ${filters.level}`);
  const scope = parts.length === 0 ? '' : ` (${parts.join(', ')})`;
  return `## Sebastian log — ${printed} of ${matching} entries${scope}`;
}

// One row per line. The hook column pads to the longest name on the page, and only a timed row
// carries a duration: a body's own message has none, and printing 0ms would invent one.
function render(rows: LogRow[]): string {
  const width = Math.max(0, ...rows.map((r) => hookName(r).length));
  return rows.map((r) => `${line(r, width)}\n`).join('');
}

function line(r: LogRow, width: number): string {
  const cells = [timestamp(r.ts), hookName(r).padEnd(width), r.level.padEnd(4), r.msg];
  const duration = r.ms === null ? '' : `  ${r.ms}ms`;
  return `${cells.join('  ')}${duration}`;
}

function hookName(r: LogRow): string {
  return r.hook ?? '-';
}

function timestamp(ts: string): string {
  return ts.replace('T', ' ').replace(/Z$/, '');
}
