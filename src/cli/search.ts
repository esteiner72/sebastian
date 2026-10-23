import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  logTelemetry, MAX_LIMIT, queryTokens, searchMessages, sessionCounts, sessionsMatching,
  type MessageHit, type SearchFilters,
} from '../store/db.js';
import type { AnchorType } from '../transcript/anchors.js';
import { cycleFlag, integer, turnRange, typeFlag, UsageError, usageWrap } from './args.js';
import { capOutput, listSome, OUTPUT_TOKENS, plural, qualifiedRef, snippetAround } from './output.js';

const HINT = '--type, --cycle, or a smaller --limit';

type SessionCount = { sessionId: string; hits: number };

// One block of the page: a heading, its best hits by rank, and the size of its whole match per
// session, which orders the block and feeds the counts line.
interface Group {
  label: string;
  hits: MessageHit[];
  counts: SessionCount[];
  total: number;
}

// The calling session prints first, then every other session, so `head` never hides the caller's
// own hits behind sessions whose ids sort earlier. `--session` narrows to one session. Sessions
// fork, chain and restart, so the other sessions stay in the answer by default.
export function search(db: DatabaseSync, argv: string[], caller?: string): string {
  const { query, filters, notes } = parseSearch(db, argv);
  const groups = findGroups(db, query, filters, caller);
  const shown = groups.flatMap((g) => g.hits);
  logSearch(db, filters, shown);
  const prefix = notes.map((n) => `${n}\n`).join('');
  if (shown.length === 0) return `${prefix}${zeroResult(db, query, filters)}`;
  return `${prefix}${render(query, groups, filters, caller)}`;
}

function parseSearch(
  db: DatabaseSync,
  argv: string[],
): { query: string; filters: SearchFilters; notes: string[] } {
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
  const type = typeFlag(values.type);
  const cycle = cycleFlag(values.cycle);
  if (cycle.session !== undefined && values.session !== undefined) {
    throw new UsageError('--cycle names a session here; pass --session or --cycle, not both.');
  }
  const filters: SearchFilters = {
    type: type.type,
    role: type.role,
    cycle: cycle.cycle,
    sessionId: resolveSession(db, values.session ?? cycle.session),
    turnRange: turnRange(values.turn),
    limit: limitOf(values.limit),
  };
  const notes = [type.note, cycle.note].filter((n): n is string => n !== null);
  return { query, filters, notes };
}

// A zero or negative limit reaches the store as `LIMIT 0`, which returns nothing. The reader would
// then be told that no record matches, which is the exact wrong answer the count exists to prevent.
function limitOf(value: string | undefined): number | undefined {
  const limit = integer(value, '--limit');
  if (limit !== undefined && limit < 1) {
    throw new UsageError('--limit takes a whole number of results, at least 1');
  }
  return limit;
}

// A session arrives as the 8-character prefix that display prints, or as a whole id. Refusing an
// unresolvable one is the point: a filter that matched nothing would answer "no records", and the
// reader would conclude the material was never archived rather than that the filter was wrong.
function resolveSession(db: DatabaseSync, session: string | undefined): string | undefined {
  if (session === undefined) return undefined;
  const matches = sessionsMatching(db, session);
  if (matches.includes(session)) return session;
  const only = matches[0];
  if (only === undefined) throw new UsageError(`no session matching "${session}" in this project`);
  if (matches.length > 1) {
    throw new UsageError(`"${session}" matches ${matches.length} sessions: ${listSome(matches)}`);
  }
  return only;
}

// One count query covers the whole scope; each group then takes its own page by rank. With a
// calling session and no `--session`, the scope splits in two, the caller's block first.
function findGroups(
  db: DatabaseSync,
  query: string,
  filters: SearchFilters,
  caller: string | undefined,
): Group[] {
  const counts = sessionCounts(db, query, filters);
  const explicit = filters.sessionId;
  if (explicit !== undefined) {
    const label = explicit === caller ? 'This session' : `Session ${explicit.slice(0, 8)}`;
    return [group(db, query, filters, label, counts)];
  }
  if (caller === undefined) return [group(db, query, filters, 'All sessions', counts)];
  const mine = counts.filter((c) => c.sessionId === caller);
  const others = counts.filter((c) => c.sessionId !== caller);
  return [
    group(db, query, { ...filters, sessionId: caller }, 'This session', mine),
    group(db, query, { ...filters, excludeSessionId: caller }, 'Other sessions', others),
  ];
}

function group(
  db: DatabaseSync,
  query: string,
  filters: SearchFilters,
  label: string,
  counts: SessionCount[],
): Group {
  const total = counts.reduce((n, c) => n + c.hits, 0);
  const hits = total === 0 ? [] : searchMessages(db, query, filters);
  return { label, hits, counts, total };
}

// Relevance selects each group's page and position renders it: sessions in the order the counts
// line names them, then transcript order, because a reader scanning hits is reconstructing a
// session, not ranking one. The counts line comes first because it is the line `head` always keeps.
function render(query: string, groups: Group[], filters: SearchFilters, caller: string | undefined): string {
  const tokens = queryTokens(query);
  const body = groups
    .filter((g) => g.hits.length > 0)
    .map((g) => `${groupHeading(g)}${ordered(g).map((h) => `${hitLine(h, tokens)}\n`).join('')}`)
    .join('');
  return (
    `${countsLine(query, groups, filters, caller)}${capOutput(body, OUTPUT_TOKENS, HINT)}` +
    `Retrieve one with \`seb show <ref>\`.\n${trailer(groups)}`
  );
}

function ordered(g: Group): MessageHit[] {
  const rank = new Map(g.counts.map((c, i) => [c.sessionId, i]));
  return [...g.hits].sort(
    (a, b) =>
      (rank.get(a.sessionId) ?? 0) - (rank.get(b.sessionId) ?? 0) || a.cycle - b.cycle || a.turn - b.turn,
  );
}

// One record, one line: where it sits, who said it, the anchors on it, and enough of its text to
// judge whether it is worth retrieving. Every reference is qualified and goes back to `seb show`.
function hitLine(h: MessageHit, tokens: string[]): string {
  const ref = qualifiedRef(h.sessionId, `${h.cycle}:${h.turn}`);
  const ids = h.anchors.map((a) => qualifiedRef(h.sessionId, a.id)).join(' ');
  const anchors = ids === '' ? '' : ` (${ids})`;
  return `${ref} ${h.role ?? '-'}${anchors} — ${snippetAround(h.text, tokens)}`;
}

// A page that states its own size as a total is the same lie as an empty result from a filter that
// could not resolve: the reader concludes the archive holds nothing else and stops looking.
function groupHeading({ label, hits, total }: Group): string {
  const size = hits.length >= total ? plural(total, 'hit') : `the best ${hits.length} of ${total} hits`;
  return `## ${label} — ${size}\n`;
}

function countsLine(query: string, groups: Group[], filters: SearchFilters, caller: string | undefined): string {
  const [first, second] = groups;
  if (first === undefined) return '';
  const lead = `${plural(first.total, 'hit')} for "${query}"`;
  if (filters.sessionId !== undefined) return `${lead} in ${sessionPhrase(filters.sessionId, caller)}.\n`;
  if (second === undefined) {
    return `${lead} in ${plural(first.counts.length, 'session')}: ${sessionList(first.counts)}.\n`;
  }
  const others = second.counts.length === 0
    ? 'none in other sessions'
    : `${second.total} in ${plural(second.counts.length, 'other session')}: ${sessionList(second.counts)}`;
  return `${lead} in ${sessionPhrase(caller ?? '', caller)}; ${others}.\n`;
}

function sessionPhrase(sessionId: string, caller: string | undefined): string {
  const prefix = sessionId.slice(0, 8);
  return sessionId === caller ? `this session (${prefix})` : `session ${prefix}`;
}

function sessionList(counts: SessionCount[]): string {
  return listSome(counts.map((c) => `${c.sessionId.slice(0, 8)} ${c.hits}`));
}

// At the ceiling `--limit` is no longer the lever to reach for, so it is not the one offered.
function trailer(groups: Group[]): string {
  const limited = groups.filter((g) => g.hits.length < g.total);
  if (limited.length === 0) return '';
  const narrow = 'Narrow with --type, --cycle, --turn or --session to see the rest';
  if (limited.some((g) => g.hits.length >= MAX_LIMIT)) return `${narrow}; --limit caps at ${MAX_LIMIT}.\n`;
  return `${narrow}, or raise --limit.\n`;
}

// No record holds every word. Partial matches would answer a different question, so the reader gets
// each word's own count instead, and drops the words that cannot match. A word is a whitespace-
// separated term, so `date-time-picker` counts as one. Counts use the query's filters, and the
// message names them, so a word the filters removed does not read as missing from the archive.
function zeroResult(db: DatabaseSync, query: string, filters: SearchFilters): string {
  const scope = filterPhrase(filters);
  const under = scope === '' ? '' : ` under ${scope}`;
  const terms = uniqueTerms(query);
  if (terms.length < 2) return `No records match "${query}"${under}.\n`;
  const counts = terms.map((t) => `${t} ${sessionCounts(db, t, filters).reduce((n, c) => n + c.hits, 0)}`);
  const label = scope === '' ? 'Records per word' : 'Records per word, under the same filters';
  const drop = scope === '' ? 'Drop words' : 'Drop words or filters';
  return (
    `No record has every word of "${query}"${under}.\n` +
    `${label}: ${counts.join(', ')}.\n` +
    `${drop} and search again; a word with 0 records cannot match.\n`
  );
}

// The filters in the form the reader typed them.
function filterPhrase(f: SearchFilters): string {
  const parts: string[] = [];
  if (f.sessionId !== undefined) parts.push(`--session ${f.sessionId.slice(0, 8)}`);
  if (f.cycle !== undefined) parts.push(`--cycle ${f.cycle}`);
  if (f.role === 'assistant') parts.push('--type assistant');
  if (f.type !== undefined) parts.push(`--type ${f.type}`);
  if (f.turnRange !== undefined) parts.push(`--turn ${f.turnRange.from}:${f.turnRange.to}`);
  return parts.join(' ');
}

function uniqueTerms(query: string): string[] {
  const seen = new Set<string>();
  return query.split(/\s+/).filter((t) => {
    const key = t.toLowerCase();
    if (queryTokens(t).length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// One row per anchor type the page reached, counting the records that carry it, because steering
// counts retrievals per type. A page of records without anchors is still a retrieval and logs its
// size under no type. A search that found nothing logs a zero: the drop-rate multiplier must not be
// able to mistake a miss for a recovery.
function logSearch(db: DatabaseSync, filters: SearchFilters, hits: MessageHit[]): void {
  const sessionId = filters.sessionId;
  if (hits.length === 0) {
    logTelemetry(db, { cmd: 'search', anchorType: filters.type, sessionId, hits: 0 });
    return;
  }
  const counts = new Map<AnchorType, number>();
  for (const h of hits) {
    for (const type of new Set(h.anchors.map((a) => a.type))) {
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    logTelemetry(db, { cmd: 'search', anchorType: undefined, sessionId, hits: hits.length });
    return;
  }
  for (const [type, n] of counts) {
    logTelemetry(db, { cmd: 'search', anchorType: type, sessionId, hits: n });
  }
}
