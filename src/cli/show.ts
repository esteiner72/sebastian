import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  logTelemetry, lookupAnchors, messagesInRange, sessionsAtTurn, type ArchivedMessage,
} from '../store/db.js';
import { TYPE_LETTERS, type Anchor } from '../transcript/anchors.js';
import { parseLine } from '../transcript/parse.js';
import { obj, str, TOKEN_CHARS } from '../transcript/text.js';
import { recordBlock } from './record.js';
import { integer, UsageError, usageWrap } from './args.js';
import { listSome, OUTPUT_TOKENS, plural, qualifiedRef } from './output.js';

const ANCHOR_ID = new RegExp(`^t\\d+[${Object.values(TYPE_LETTERS).join('')}]\\d+$`);
const CYCLE_TURN = /^(\d+):(\d+)$/;

interface Spot {
  sessionId: string;
  cycle: number;
  turn: number;
  anchor: Anchor | null;
}

// A record rendered as text, with the tool results that answered it. `--context N` widens the
// window by N turns each way, and turns are file positions, so the window is a contiguous slice of
// the transcript. A target too large for one page is paged, never cut, and `--page N` reads on.
export function show(db: DatabaseSync, argv: string[], caller?: string): string {
  const { target, context, page } = parseShow(argv);
  const spot = resolve(db, target, caller);
  const window = messagesInRange(db, spot.sessionId, spot.turn - context, spot.turn + context);
  logTelemetry(db, {
    cmd: 'show',
    anchorType: spot.anchor?.type,
    anchorId: spot.anchor?.id,
    sessionId: spot.sessionId,
    hits: window.length === 0 ? 0 : 1,
  });
  if (window.length === 0) {
    throw new UsageError(`${target} resolves to turn ${spot.turn}, which is not in the archive`);
  }
  const results = pairedResults(db, spot, window);
  const shown = new Set(window.map((m) => m.turn));
  const records = [...window, ...results.filter((m) => !shown.has(m.turn))];
  const resultTurns = results.map((m) => m.turn);
  const fitted = fitWindow(records, spot.turn, OUTPUT_TOKENS * TOKEN_CHARS, resultTurns, page);
  if (page > fitted.pages) {
    throw new UsageError(`${positionRef(spot)} has ${plural(fitted.pages, 'page')}`);
  }
  return render(spot, context, resultTurns, fitted);
}

// A tool call's result is usually several records away, because the records between them carry no
// uuid and are not archived, and a reader who found the call by its anchor cannot know how far. The
// next archived turns within reach are parsed, and the ones answering the target's tool_use ids
// join the window. The reach bounds the parse work: on both live archives every result sits within
// six archived turns of its call.
const RESULT_REACH = 8;

function pairedResults(db: DatabaseSync, spot: Spot, window: ArchivedMessage[]): ArchivedMessage[] {
  const target = window.find((m) => m.turn === spot.turn);
  if (target === undefined) return [];
  const calls = toolUseIds(parseLine(target.raw));
  if (calls.size === 0) return [];
  return messagesInRange(db, spot.sessionId, spot.turn + 1, spot.turn + RESULT_REACH)
    .filter((m) => toolResultIds(parseLine(m.raw)).some((id) => calls.has(id)));
}

function contentBlocks(record: Record<string, unknown> | null): Record<string, unknown>[] {
  const content = obj(record?.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.map((b) => obj(b)).filter((b): b is Record<string, unknown> => b !== null);
}

function toolUseIds(record: Record<string, unknown> | null): Set<string> {
  const ids = contentBlocks(record)
    .filter((b) => str(b.type) === 'tool_use')
    .map((b) => str(b.id))
    .filter((id): id is string => id !== null);
  return new Set(ids);
}

function toolResultIds(record: Record<string, unknown> | null): string[] {
  return contentBlocks(record)
    .filter((b) => str(b.type) === 'tool_result')
    .map((b) => str(b.tool_use_id))
    .filter((id): id is string => id !== null);
}

function parseShow(argv: string[]): { target: string; context: number; page: number } {
  const { values, positionals } = usageWrap(() =>
    parseArgs({
      args: argv,
      allowPositionals: true,
      options: { context: { type: 'string' }, page: { type: 'string' } },
    }),
  );
  const target = positionals[0];
  if (target === undefined || positionals.length > 1) {
    throw new UsageError('seb show takes one target: seb show <ref> [--context N] [--page N]');
  }
  const context = integer(values.context, '--context') ?? 0;
  if (context < 0) throw new UsageError('--context takes a whole number of turns, at least 0');
  const page = integer(values.page, '--page') ?? 1;
  if (page < 1) throw new UsageError('--page takes a whole number, at least 1');
  return { target, context, page };
}

// Both target forms accept the `{session prefix}/` qualifier that display adds. The prefix is
// never a key — it resolves by prefix match — and it is the only way to name one of two sessions
// that reached the same session-local id or the same file position. A bare target means the
// calling session when that session holds it, and otherwise whichever one session does.
function resolve(db: DatabaseSync, target: string, caller: string | undefined): Spot {
  const slash = target.indexOf('/');
  const rest = slash === -1 ? target : target.slice(slash + 1);
  const prefixes = slash === -1 ? [caller, undefined] : [target.slice(0, slash)];
  const position = CYCLE_TURN.exec(rest);
  if (position !== null) return resolveTurn(db, prefixes, position);
  if (ANCHOR_ID.test(rest)) return resolveAnchor(db, target, prefixes, rest);
  throw new UsageError(
    `"${target}" is neither an anchor id (t41e1, 344e260c/t41e1) nor a cycle:turn position (2:41)`,
  );
}

// The prefixes are tried in order and the first that matches anything decides. An undefined
// caller makes the first try a whole-archive lookup, which is harmless.
function firstMatch<T>(prefixes: (string | undefined)[], lookup: (prefix?: string) => T[]): T[] {
  for (const prefix of prefixes) {
    const matches = lookup(prefix);
    if (matches.length > 0) return matches;
  }
  return [];
}

function resolveAnchor(
  db: DatabaseSync,
  target: string,
  prefixes: (string | undefined)[],
  id: string,
): Spot {
  const matches = firstMatch(prefixes, (prefix) => lookupAnchors(db, id, prefix));
  const anchor = matches[0];
  if (anchor === undefined) {
    throw new UsageError(`no anchor ${target} in this project's archive; try \`seb search\``);
  }
  if (matches.length > 1) throw new UsageError(ambiguous(id, matches.map((a) => a.sessionId)));
  return { sessionId: anchor.sessionId, cycle: anchor.cycle, turn: anchor.turn, anchor };
}

function resolveTurn(
  db: DatabaseSync,
  prefixes: (string | undefined)[],
  position: RegExpExecArray,
): Spot {
  const cycle = Number(position[1]);
  const turn = Number(position[2]);
  const sessions = firstMatch(prefixes, (prefix) => sessionsAtTurn(db, cycle, turn, prefix));
  const sessionId = sessions[0];
  if (sessionId === undefined) {
    throw new UsageError(`no archived record at cycle ${cycle}, turn ${turn}`);
  }
  if (sessions.length > 1) throw new UsageError(ambiguous(`${cycle}:${turn}`, sessions));
  return { sessionId, cycle, turn, anchor: null };
}

// The forms listed are the qualified display ids, which is exactly what `seb show` accepts back,
// so the reader retries by copying one. The bare id is qualified here, never the typed target: a
// target that already carries a prefix would otherwise be qualified twice.
function ambiguous(id: string, sessions: string[]): string {
  const forms = listSome(sessions.map((s) => qualifiedRef(s, id)));
  return `${id} exists in ${sessions.length} sessions: ${forms} — name one by its prefix`;
}

function positionRef(spot: Spot): string {
  return qualifiedRef(spot.sessionId, `${spot.cycle}:${spot.turn}`);
}

function render(spot: Spot, context: number, resultTurns: number[], fitted: ShowPage): string {
  const what = spot.anchor === null
    ? ''
    : `${spot.anchor.type} anchor ${qualifiedRef(spot.sessionId, spot.anchor.id)}, `;
  const window = context === 0 ? '' : `, ±${plural(context, 'turn')}`;
  const paged = fitted.pages === 1 ? '' : `, page ${fitted.page} of ${fitted.pages}`;
  const heading =
    `## ${positionRef(spot)} — ${what}session ${spot.sessionId}, cycle ${spot.cycle}, ` +
    `turn ${spot.turn}${window}${resultsSuffix(spot, resultTurns)}${paged}\n`;
  return `${heading}${fitted.body}${nextPage(spot, fitted)}${omittedFooter(fitted.omitted)}`;
}

function resultsSuffix(spot: Spot, turns: number[]): string {
  const refs = turns.map((t) => qualifiedRef(spot.sessionId, `${spot.cycle}:${t}`));
  if (refs.length === 0) return '';
  if (refs.length === 1) return `, with its result at ${refs[0]}`;
  return `, with its results at ${refs.join(', ')}`;
}

function nextPage(spot: Spot, { page, pages }: ShowPage): string {
  if (page >= pages) return '';
  return `Page ${page} of ${pages} — next: \`seb show ${positionRef(spot)} --page ${page + 1}\`.\n`;
}

function omittedFooter(omitted: ArchivedMessage[]): string {
  if (omitted.length === 0) return '';
  const refs = omitted.map((m) => qualifiedRef(m.sessionId, `${m.cycle}:${m.turn}`)).join(', ');
  return `… context omitted: ${refs} — view one with \`seb show <ref>\`.\n`;
}

export interface ShowPage {
  body: string;
  page: number;
  pages: number;
  omitted: ArchivedMessage[];
}

// The target and the results that answered it are the primary text. When it fits the room it prints
// whole and context fills what is left, nearest first, ties toward the earlier turn; a context
// record too large for what is left is skipped rather than ending the scan, so one bulky neighbour
// cannot hide the small ones behind it. When the primary text does not fit, it is paged and context
// is omitted. A page past the last has an empty body, which the caller reports.
export function fitWindow(
  records: ArchivedMessage[],
  targetTurn: number,
  room: number,
  resultTurns: number[],
  page: number,
): ShowPage {
  const isPrimary = (m: ArchivedMessage): boolean => m.turn === targetTurn || resultTurns.includes(m.turn);
  const primary = records.filter(isPrimary).sort(byTurn).map(recordBlock).join('');
  const others = records.filter((m) => !isPrimary(m)).sort(byTurn);
  if (primary.length > room) {
    const pages = paginate(primary, room);
    return { body: pages[page - 1] ?? '', page, pages: pages.length, omitted: others };
  }
  let left = room - primary.length;
  const kept: ArchivedMessage[] = [];
  const omitted: ArchivedMessage[] = [];
  for (const m of [...others].sort(byDistance(targetTurn))) {
    const size = recordBlock(m).length;
    if (size > left) {
      omitted.push(m);
      continue;
    }
    left -= size;
    kept.push(m);
  }
  const body = [...records.filter(isPrimary), ...kept].sort(byTurn).map(recordBlock).join('');
  return { body, page: 1, pages: 1, omitted: omitted.sort(byTurn) };
}

// Pages break between lines. A line longer than the room fills what is left of the current page and
// runs on across as many pages as it needs, so a minified tool result never leaves a page holding
// only a header. Joined back together, the pages are the text exactly.
function paginate(text: string, room: number): string[] {
  const pages: string[] = [];
  let current = '';
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (current.length + line.length <= room) {
      current += line;
      continue;
    }
    let rest = line;
    if (line.length <= room) {
      pages.push(current);
      current = '';
    }
    while (current.length + rest.length > room) {
      const take = room - current.length;
      pages.push(current + rest.slice(0, take));
      current = '';
      rest = rest.slice(take);
    }
    current += rest;
  }
  if (current !== '') pages.push(current);
  return pages;
}

function byTurn(a: ArchivedMessage, b: ArchivedMessage): number {
  return a.turn - b.turn;
}

function byDistance(target: number): (a: ArchivedMessage, b: ArchivedMessage) => number {
  return (a, b) => Math.abs(a.turn - target) - Math.abs(b.turn - target) || a.turn - b.turn;
}
