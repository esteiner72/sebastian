import type { TranscriptEvent } from './parse.js';
import { extractErrorSignatures } from './errors.js';
import {
  contentTokens, genuineUserText, isQuestion, obj, questionKey, selectQuote, str,
} from './text.js';

export type AnchorType = 'error' | 'answer' | 'edit' | 'user' | 'cmd' | 'read' | 'url';

export interface Anchor {
  id: string;
  uuid: string;
  sessionId: string;
  cycle: number;
  turn: number;
  type: AnchorType;
  key: string;
  excerpt: string;
}

// One letter per type, and the set is closed: a new anchor type must claim an unused letter in
// the same commit that introduces it, or ids stop being decodable.
export const TYPE_LETTERS: Record<AnchorType, string> = {
  error: 'e', answer: 'a', edit: 'd', user: 'u', cmd: 'c', read: 'r', url: 'w',
};

export const ANCHOR_TYPES = Object.keys(TYPE_LETTERS) as AnchorType[];

type Draft = Omit<Anchor, 'id'>;

interface PendingQuestion {
  key: string;
  answered: boolean;
  userCandidate: Draft | null;
}

export function extractAnchors(events: TranscriptEvent[]): Anchor[] {
  const resultBodies = indexToolResults(events);
  const drafts: Draft[] = [];
  let pending: PendingQuestion | null = null;
  for (const event of events) {
    if (event.type === 'assistant') {
      pending = scanAssistant(event, pending, drafts, resultBodies);
    } else if (event.type === 'user') {
      pending = scanUser(event, pending, drafts);
    }
  }
  flushUserCandidate(pending, drafts);
  return assignIds(drafts);
}

// Ids are t{turn}{typeLetter}{ordinal}: deterministic from file position and record content, so
// re-extracting a transcript reproduces identical ids and appends cannot renumber earlier ones.
function assignIds(drafts: Draft[]): Anchor[] {
  const sorted = [...drafts].sort((a, b) => a.turn - b.turn);
  const ordinals = new Map<string, number>();
  return sorted.map((d) => {
    const slot = `${d.turn}:${d.type}`;
    const ordinal = (ordinals.get(slot) ?? 0) + 1;
    ordinals.set(slot, ordinal);
    return { ...d, id: `t${d.turn}${TYPE_LETTERS[d.type]}${ordinal}` };
  });
}

function indexToolResults(events: TranscriptEvent[]): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const event of events) {
    for (const block of toolResultBlocks(event)) {
      const id = str(block.tool_use_id);
      if (id !== null) bodies.set(id, blockBody(block));
    }
  }
  return bodies;
}

function toolResultBlocks(event: TranscriptEvent): Record<string, unknown>[] {
  if (event.type !== 'user') return [];
  const content = obj(event.record?.message)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .map((b) => obj(b))
    .filter((b): b is Record<string, unknown> => b !== null && str(b.type) === 'tool_result');
}

function blockBody(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => str(obj(b)?.text) ?? '')
    .filter((t) => t !== '')
    .join('\n');
}

function scanAssistant(
  event: TranscriptEvent,
  pending: PendingQuestion | null,
  drafts: Draft[],
  resultBodies: Map<string, string>,
): PendingQuestion | null {
  const content = obj(event.record?.message)?.content;
  const blocks = Array.isArray(content) ? content.map((b) => obj(b)) : [];
  const next = answerFromProse(event, pending, drafts, blocks);
  for (const block of blocks) {
    if (block !== null && str(block.type) === 'tool_use') {
      pushToolAnchors(event, block, drafts, resultBodies);
    }
  }
  return next;
}

// The answer window: assistant messages after a user question, up to the next genuine user
// message. The first prose block is the answer's opening; a tool-calls-only reply produces no
// anchor, because synthesis, not activity, is the target.
function answerFromProse(
  event: TranscriptEvent,
  pending: PendingQuestion | null,
  drafts: Draft[],
  blocks: (Record<string, unknown> | null)[],
): PendingQuestion | null {
  if (pending === null || pending.answered || event.uuid === null) return pending;
  const prose = blocks
    .filter((b) => b !== null && str(b.type) === 'text')
    .map((b) => (str(b?.text) ?? '').trim())
    .find((t) => t !== '');
  if (prose === undefined) return pending;
  drafts.push({ ...draftBase(event, 'answer'), key: pending.key, excerpt: prose.slice(0, 200) });
  return { ...pending, answered: true, userCandidate: null };
}

function scanUser(
  event: TranscriptEvent,
  pending: PendingQuestion | null,
  drafts: Draft[],
): PendingQuestion | null {
  const blocks = toolResultBlocks(event);
  if (blocks.length > 0) {
    pushErrorAnchors(event, blocks, drafts);
    return pending;
  }
  const text = genuineUserText(event);
  if (text === null) return pending;
  flushUserCandidate(pending, drafts);
  return nextPending(event, text, drafts);
}

// A question defers its user anchor: if an answer anchor lands, the utterance is never indexed
// twice; if no answer follows, the candidate flushes as a plain user anchor.
function nextPending(event: TranscriptEvent, text: string, drafts: Draft[]): PendingQuestion | null {
  const candidate = userCandidate(event, text);
  if (!isQuestion(text)) {
    if (candidate !== null) drafts.push(candidate);
    return null;
  }
  return { key: questionKey(text), answered: false, userCandidate: candidate };
}

function userCandidate(event: TranscriptEvent, text: string): Draft | null {
  if (event.uuid === null || contentTokens(text).length < 3) return null;
  return { ...draftBase(event, 'user'), key: selectQuote(text), excerpt: text.slice(0, 200) };
}

function flushUserCandidate(pending: PendingQuestion | null, drafts: Draft[]): void {
  if (pending !== null && pending.userCandidate !== null) drafts.push(pending.userCandidate);
}

function pushErrorAnchors(
  event: TranscriptEvent,
  blocks: Record<string, unknown>[],
  drafts: Draft[],
): void {
  if (event.uuid === null) return;
  for (const block of blocks) {
    for (const sig of extractErrorSignatures(blockBody(block), block.is_error === true)) {
      drafts.push({ ...draftBase(event, 'error'), key: sig.key, excerpt: sig.excerpt });
    }
  }
}

function pushToolAnchors(
  event: TranscriptEvent,
  block: Record<string, unknown>,
  drafts: Draft[],
  resultBodies: Map<string, string>,
): void {
  if (event.uuid === null) return;
  const name = str(block.name) ?? '';
  const input = obj(block.input) ?? {};
  for (const { type, key } of toolAnchorKeys(name, input, block, resultBodies)) {
    drafts.push({ ...draftBase(event, type), key, excerpt: key.slice(0, 200) });
  }
}

function toolAnchorKeys(
  name: string,
  input: Record<string, unknown>,
  block: Record<string, unknown>,
  resultBodies: Map<string, string>,
): { type: AnchorType; key: string }[] {
  const path = str(input.file_path) ?? str(input.notebook_path);
  if (['Edit', 'Write', 'NotebookEdit'].includes(name) && path !== null) {
    return [{ type: 'edit', key: path }];
  }
  if (name === 'Read' && path !== null) return [{ type: 'read', key: path }];
  if (name === 'Bash') return bashAnchorKeys(str(input.command), block, resultBodies);
  return urlAnchorKeys(name, input);
}

// WebSearch has no URL in its input, so its query is the closest stable identifier.
function urlAnchorKeys(
  name: string,
  input: Record<string, unknown>,
): { type: AnchorType; key: string }[] {
  const key = name === 'WebFetch' ? str(input.url) : name === 'WebSearch' ? str(input.query) : null;
  return key === null ? [] : [{ type: 'url', key }];
}

// A Bash anchor keys on the command line, and on the exit code only when it is non-zero: a
// successful run and a result that carries no exit header must not key as two different things.
function bashAnchorKeys(
  command: string | null,
  block: Record<string, unknown>,
  resultBodies: Map<string, string>,
): { type: AnchorType; key: string }[] {
  if (command === null) return [];
  const body = resultBodies.get(str(block.id) ?? '') ?? '';
  const exit = /^Exit code ([1-9]\d*)/.exec(body);
  const cmdKey = exit === null ? command : `${command} (exit ${exit[1]})`;
  const keys: { type: AnchorType; key: string }[] = [{ type: 'cmd', key: cmdKey.slice(0, 300) }];
  for (const readPath of bashReadPaths(command)) keys.push({ type: 'read', key: readPath });
  return keys;
}

// Sessions frequently read files with sed/rg/cat/head/tail instead of the Read tool; without
// this, every such re-read is invisible (one corpus session: 209 cmd anchors vs 2 read anchors).
const FILE_READ_CMDS = new Set(['sed', 'rg', 'cat', 'head', 'tail']);

function bashReadPaths(command: string): string[] {
  const paths = new Set<string>();
  for (const segment of shellSegments(command)) {
    const tokens = segment.trim().split(/\s+/).filter((t) => t !== '');
    const cmd = (tokens[0] ?? '').split('/').pop() ?? '';
    if (!FILE_READ_CMDS.has(cmd)) continue;
    for (const operand of pathOperands(cmd, tokens.slice(1))) paths.add(operand);
  }
  return [...paths];
}

// Segment split on the shell operators `&&`, `||`, `|`, and `;`, ignoring any that sit inside
// single or double quotes: an rg alternation such as "timeout|retry" would otherwise end the
// segment and hide the file operand behind it. Backslash escapes and command substitution are out
// of scope, because a path inside `$(...)` is not a plain read.
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? '';
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const width = separatorWidth(command, i);
    if (width === 0) {
      current += ch;
      continue;
    }
    segments.push(current);
    current = '';
    i += width - 1;
  }
  segments.push(current);
  return segments;
}

function separatorWidth(command: string, at: number): number {
  if (command.startsWith('&&', at) || command.startsWith('||', at)) return 2;
  const ch = command[at];
  return ch === '|' || ch === ';' ? 1 : 0;
}

// sed's script and rg's pattern occupy the first non-flag slot, so it is skipped for those two.
// An operand counts as a path when it contains a slash or a file extension; quoted tokens are
// scripts or patterns, never paths, and a token carrying a redirection operator is a stream
// target, not a read — `cat notes.txt 2>/dev/null` reads one file, not two.
function pathOperands(cmd: string, args: string[]): string[] {
  const operands = args.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a));
  const skipFirst = cmd === 'sed' || cmd === 'rg' ? 1 : 0;
  return operands
    .slice(skipFirst)
    .filter((a) => !/['"<>]/.test(a) && (a.includes('/') || /\.\w+$/.test(a)));
}

function draftBase(
  event: TranscriptEvent,
  type: AnchorType,
): Omit<Draft, 'key' | 'excerpt'> {
  return {
    uuid: event.uuid ?? '',
    sessionId: event.sessionId ?? '',
    cycle: event.cycle,
    turn: event.turn,
    type,
  };
}
