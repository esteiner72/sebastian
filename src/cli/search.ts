import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  countAnchors, logTelemetry, MAX_LIMIT, searchAnchors, sessionsMatching, type AnchorFilters,
} from '../store/db.js';
import type { Anchor } from '../transcript/anchors.js';
import { anchorType, integer, turnRange, UsageError, usageWrap } from './args.js';
import { anchorLine, capOutput, OUTPUT_TOKENS, plural, spansSessions } from './output.js';

const HINT = '--type, --cycle, or a smaller --limit';

// Project scope is the default and `--session` narrows it: sessions fork, chain and restart, and a
// reader asking what was decided about something does not know which session id holds it.
export function search(db: DatabaseSync, argv: string[]): string {
  const { query, filters } = parseSearch(argv);
  filters.sessionId = resolveSession(db, filters.sessionId);
  const hits = searchAnchors(db, query, filters);
  logSearch(db, filters, hits);
  return render(query, hits, countAnchors(db, query, filters));
}

function parseSearch(argv: string[]): { query: string; filters: AnchorFilters } {
  const { values, positionals } = usageWrap(() =>
    parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        type: { type: 'string' },
        cycle: { type: 'string' },
        session: { type: 'string' },
        turn: { type: 'string' },
        limit: { type: 'string' },
      },
    }),
  );
  const query = positionals.join(' ').trim();
  if (query === '') throw new UsageError('seb search needs a query: seb search <query> [--type …]');
  return {
    query,
    filters: {
      type: anchorType(values.type),
      cycle: integer(values.cycle, '--cycle'),
      sessionId: values.session,
      turnRange: turnRange(values.turn),
      limit: limitOf(values.limit),
    },
  };
}

// A zero or negative limit reaches the store as `LIMIT 0`, which returns nothing. The reader would
// then be told that no anchor matches, which is the exact wrong answer the count exists to prevent.
function limitOf(value: string | undefined): number | undefined {
  const limit = integer(value, '--limit');
  if (limit !== undefined && limit < 1) {
    throw new UsageError('--limit takes a whole number of results, at least 1');
  }
  return limit;
}

// A session arrives as the 8-character prefix that display prints, or as a whole id. Refusing an
// unresolvable one is the point: a filter that matched nothing would answer "no anchors", and the
// reader would conclude the material was never archived rather than that the filter was wrong.
function resolveSession(db: DatabaseSync, session: string | undefined): string | undefined {
  if (session === undefined) return undefined;
  const matches = sessionsMatching(db, session);
  if (matches.includes(session)) return session;
  const only = matches[0];
  if (only === undefined) throw new UsageError(`no session matching "${session}" in this project`);
  if (matches.length > 1) {
    throw new UsageError(`"${session}" matches ${matches.length} sessions: ${matches.join(', ')}`);
  }
  return only;
}

// Relevance selects the page — the store orders by FTS rank — and position renders it, because a
// reader scanning a page of hits is reconstructing a session, not ranking one.
function render(query: string, hits: Anchor[], total: number): string {
  if (hits.length === 0) return `No anchors match "${query}".\n`;
  const qualified = spansSessions(hits);
  const body = [...hits]
    .sort(byPosition)
    .map((a) => `${anchorLine(a, qualified)}\n`)
    .join('');
  return (
    `${heading(query, hits.length, total)}${capOutput(body, OUTPUT_TOKENS, HINT)}` +
    `Retrieve an original with \`seb show <id>\`.\n${trailer(hits.length, total)}`
  );
}

// A page that states its own size as a total is the same lie as an empty result from a filter that
// could not resolve: the reader concludes the archive holds nothing else and stops looking.
function heading(query: string, shown: number, total: number): string {
  if (shown >= total) return `${plural(shown, 'anchor')} for "${query}":\n`;
  return `${shown} of ${plural(total, 'anchor')} for "${query}" — showing the ${shown} best matches.\n`;
}

// At the ceiling `--limit` is no longer the lever to reach for, so it is not the one offered.
function trailer(shown: number, total: number): string {
  if (shown >= total) return '';
  if (shown >= MAX_LIMIT) {
    return `Narrow with --type, --cycle or --turn to see the rest; --limit caps at ${MAX_LIMIT}.\n`;
  }
  return 'Raise --limit or narrow with --type, --cycle or --turn to see the rest.\n';
}

function byPosition(a: Anchor, b: Anchor): number {
  return (
    a.sessionId.localeCompare(b.sessionId) || a.cycle - b.cycle || a.turn - b.turn ||
    a.id.localeCompare(b.id)
  );
}

// One row per type the search reached, because steering counts retrievals per type. A search that
// found nothing still logs a row, at zero hits: the drop-rate multiplier must not be able to
// mistake a miss for a recovery.
function logSearch(db: DatabaseSync, filters: AnchorFilters, hits: Anchor[]): void {
  const counts = new Map<string, number>();
  for (const a of hits) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  if (counts.size === 0) {
    logTelemetry(db, { cmd: 'search', anchorType: filters.type, sessionId: filters.sessionId, hits: 0 });
    return;
  }
  for (const [type, n] of counts) {
    logTelemetry(db, { cmd: 'search', anchorType: type, sessionId: filters.sessionId, hits: n });
  }
}
