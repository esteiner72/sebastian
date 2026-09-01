import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  logTelemetry, lookupAnchors, messagesInRange, sessionsAtTurn, type ArchivedMessage,
} from '../store/db.js';
import type { Anchor } from '../transcript/anchors.js';
import { TOKEN_CHARS } from '../transcript/text.js';
import { integer, UsageError, usageWrap } from './args.js';
import { displayId, OUTPUT_TOKENS, plural } from './output.js';

const ANCHOR_ID = /^t\d+[eaducrw]\d+$/;
const CYCLE_TURN = /^(\d+):(\d+)$/;

interface Spot {
  sessionId: string;
  cycle: number;
  turn: number;
  anchor: Anchor | null;
}

// The record as it was written, not a rendering of it: the archive's whole promise is that the
// original line survives compaction, so `seb show` hands back that line and lets the reader parse
// it. `--context N` widens the window by N turns each way, and turns are file positions, so the
// window is a contiguous slice of the transcript.
export function show(db: DatabaseSync, argv: string[]): string {
  const { target, context } = parseShow(argv);
  const spot = resolve(db, target);
  const records = messagesInRange(db, spot.sessionId, spot.turn - context, spot.turn + context);
  logTelemetry(db, {
    cmd: 'show',
    anchorType: spot.anchor?.type,
    anchorId: spot.anchor?.id,
    sessionId: spot.sessionId,
    hits: records.length === 0 ? 0 : 1,
  });
  if (records.length === 0) {
    throw new UsageError(`${target} resolves to turn ${spot.turn}, which is not in the archive`);
  }
  return render(target, spot, context, records);
}

function parseShow(argv: string[]): { target: string; context: number } {
  const { values, positionals } = usageWrap(() =>
    parseArgs({ args: argv, allowPositionals: true, options: { context: { type: 'string' } } }),
  );
  const target = positionals[0];
  if (target === undefined || positionals.length > 1) {
    throw new UsageError('seb show takes one target: seb show <anchor-id | cycle:turn> [--context N]');
  }
  const context = integer(values.context, '--context') ?? 0;
  if (context < 0) throw new UsageError('--context takes a whole number of turns, at least 0');
  return { target, context };
}

// Both target forms accept the `{session prefix}/` qualifier that display adds. The prefix is
// never a key — it resolves by prefix match — and it is the only way to name one of two sessions
// that reached the same session-local id or the same file position.
function resolve(db: DatabaseSync, target: string): Spot {
  const slash = target.indexOf('/');
  const prefix = slash === -1 ? undefined : target.slice(0, slash);
  const rest = slash === -1 ? target : target.slice(slash + 1);
  const position = CYCLE_TURN.exec(rest);
  if (position !== null) return resolveTurn(db, prefix, position);
  if (ANCHOR_ID.test(rest)) return resolveAnchor(db, target, prefix, rest);
  throw new UsageError(
    `"${target}" is neither an anchor id (t41e1, 344e260c/t41e1) nor a cycle:turn position (2:41)`,
  );
}

function resolveAnchor(
  db: DatabaseSync,
  target: string,
  prefix: string | undefined,
  id: string,
): Spot {
  const matches = lookupAnchors(db, id, prefix);
  const anchor = matches[0];
  if (anchor === undefined) {
    throw new UsageError(`no anchor ${target} in this project's archive; try \`seb search\``);
  }
  if (matches.length > 1) throw new UsageError(ambiguous(id, matches.map((a) => a.sessionId)));
  return { sessionId: anchor.sessionId, cycle: anchor.cycle, turn: anchor.turn, anchor };
}

function resolveTurn(db: DatabaseSync, prefix: string | undefined, position: RegExpExecArray): Spot {
  const cycle = Number(position[1]);
  const turn = Number(position[2]);
  const sessions = sessionsAtTurn(db, cycle, turn, prefix);
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
  const forms = sessions.map((s) => displayId(s, id, true)).join(', ');
  return `${id} exists in ${sessions.length} sessions: ${forms} — name one by its prefix`;
}

function render(target: string, spot: Spot, context: number, records: ArchivedMessage[]): string {
  const what = spot.anchor === null ? '' : `${spot.anchor.type} anchor, `;
  const window = context === 0 ? '' : `, ±${plural(context, 'turn')}`;
  const heading =
    `## show ${target} — ${what}session ${spot.sessionId}, cycle ${spot.cycle}, turn ${spot.turn}${window}\n`;
  return `${heading}${fitWindow(records, spot.turn, OUTPUT_TOKENS * TOKEN_CHARS)}`;
}

// The target record is allocated before its context, and truncated rather than dropped. A listing
// can lose a line and still answer; a `seb show` that omits the record it was asked for answers
// nothing. Context records are individually retrievable by position, so dropping one whole and
// pointing at it stays honest — the target has no other way out.
export function fitWindow(records: ArchivedMessage[], targetTurn: number, room: number): string {
  const target = records.find((m) => m.turn === targetTurn);
  const others = records.filter((m) => m.turn !== targetTurn);
  // The footer's room is reserved before the target is allocated, so a target that fills the
  // budget can still report what it displaced.
  const budget = room - (others.length === 0 ? 0 : omitted(others.length).length);
  const blocks: { turn: number; text: string }[] = [];
  let left = budget;
  if (target !== undefined) {
    const text = targetBlock(target, budget);
    blocks.push({ turn: target.turn, text });
    left -= text.length;
  }
  // Nearest first, ties toward the earlier turn. A record too large for what is left is skipped
  // rather than ending the scan, so one bulky neighbour cannot hide the small ones behind it.
  let dropped = 0;
  for (const m of [...others].sort(byDistance(targetTurn))) {
    const text = recordBlock(m);
    if (text.length > left) {
      dropped += 1;
      continue;
    }
    left -= text.length;
    blocks.push({ turn: m.turn, text });
  }
  const body = blocks.sort((a, b) => a.turn - b.turn).map((b) => b.text).join('');
  return dropped === 0 ? body : `${body}${omitted(dropped)}`;
}

function byDistance(target: number): (a: ArchivedMessage, b: ArchivedMessage) => number {
  return (a, b) => Math.abs(a.turn - target) - Math.abs(b.turn - target) || a.turn - b.turn;
}

// The marker's own length depends on the count it prints, so it is measured at the widest that
// count can be — the whole budget — and the slice takes what is left. That wastes a character or
// two and keeps the cut computable in one pass.
function targetBlock(m: ArchivedMessage, budget: number): string {
  const whole = recordBlock(m);
  if (whole.length <= budget) return whole;
  const header = headerLine(m);
  const shown = Math.max(0, budget - header.length - marker(budget, m.raw.length).length);
  return `${header}${m.raw.slice(0, shown)}${marker(shown, m.raw.length)}`;
}

function recordBlock(m: ArchivedMessage): string {
  return `${headerLine(m)}${m.raw}\n`;
}

function headerLine(m: ArchivedMessage): string {
  return `turn ${m.turn}  ${m.role ?? '-'}  ${m.ts ?? '-'}\n`;
}

function marker(shown: number, total: number): string {
  return `… [truncated: ${shown} of ${total} chars shown]\n`;
}

function omitted(n: number): string {
  return `… ${plural(n, 'context turn')} omitted — view one with \`seb show <cycle:turn>\`.\n`;
}
