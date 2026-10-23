import type { TranscriptEvent } from './parse.js';
import { isSebOnly } from './shell.js';

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Tokenization shared by user-anchor selection, question keys, and (later) Jaccard reconciliation:
// lowercase, split on non-alphanumerics, drop stopwords and sub-3-character tokens.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'has', 'have', 'was',
  'were', 'been', 'being', 'that', 'this', 'these', 'those', 'with', 'from', 'into', 'onto',
  'about', 'over', 'under', 'again', 'then', 'than', 'they', 'them', 'their', 'its', 'his',
  'her', 'she', 'him', 'our', 'ours', 'your', 'yours', 'out', 'off', 'too', 'very', 'just',
  'also', 'does', 'did', 'doing', 'will', 'would', 'should', 'could', 'shall', 'may', 'might',
  'must', 'here', 'there', 'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'how',
  'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same',
  'now', 'please',
]);

export function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// The normalized-question key: content tokens sorted and joined, so word order and phrasing
// variation do not split identical questions. Every interrogative is also a stopword, so a short
// question ("Why?", "Is it?") has no content tokens at all and falls back to its own words: an
// empty key indexes nothing in the anchor index and would make two unrelated answers look like one
// question to reconciliation.
export function questionKey(text: string): string {
  const tokens = [...new Set(contentTokens(text))].sort();
  if (tokens.length > 0) return tokens.join(' ');
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return words === '' ? text.trim().replace(/\s+/g, ' ') : words;
}

// Openers that mark a question on their own. `do` is the one auxiliary left out, measured over
// 227 transcripts and 1,351 genuine user messages: every `do` opener without a `?` is an
// imperative ("Do #2 while I sort out the access issue"), while every other auxiliary opener
// without a `?` is a question, `can` alone accounting for 62 of them. `do` still qualifies
// through the trailing `?`. Both directions of error cost something: a directive read as a
// question surrenders its verbatim quote and points `seb show` at the reply instead of the
// instruction, and a question read as a directive loses the `answer` anchor entirely.
const INTERROGATIVES = new Set([
  'what', 'why', 'how', 'when', 'where', 'which', 'who',
  'is', 'are', 'does', 'can', 'could', 'would', 'should',
]);

// The opening token is cut at its apostrophe before the lookup, so `what's` and `where's` match
// while `we're` and `don't` do not. Straight and typographic apostrophes both count, because
// platforms substitute one for the other.
export function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith('?')) return true;
  const first = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  const opener = first.split(/['\u2019]/, 1)[0]?.replace(/[^a-z]/g, '') ?? '';
  return INTERROGATIVES.has(opener);
}

// Envelope tags whose whole span is machine content, not typed human text. Stripping is
// belt-and-braces: measured on the corpus these spans never interleave with typed text.
const SPAN_ENVELOPES = [
  'command-name', 'command-message', 'command-args', 'local-command-stdout', 'bash-stdout',
  'bash-stderr', 'teammate-message', 'task-notification', 'cross-session-message',
  'system-reminder',
];

export function stripEnvelopes(text: string): string {
  let out = text;
  for (const tag of SPAN_ENVELOPES) {
    out = out.replaceAll(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'g'), ' ');
  }
  return out
    .replaceAll(/\[Request interrupted by user[^\]]*\]/g, ' ')
    .replaceAll(/\[Image #\d+\]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

// The genuine-human-message predicate. One tool_result block disqualifies the whole record —
// measured lossless: no tool_result-carrying record in the corpus contains any text block.
export function genuineUserText(event: TranscriptEvent): string | null {
  if (event.type !== 'user') return null;
  const record = event.record;
  if (record === null) return null;
  if (record.isCompactSummary === true || record.isMeta === true) return null;
  if (record.isVisibleInTranscriptOnly === true) return null;
  const content = obj(record.message)?.content;
  const text = typedText(content);
  if (text === null) return null;
  const stripped = stripEnvelopes(text);
  return stripped === '' ? null : stripped;
}

function typedText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const blocks = content.map((b) => obj(b));
  if (blocks.some((b) => str(b?.type) === 'tool_result')) return null;
  const texts = blocks.filter((b) => str(b?.type) === 'text').map((b) => str(b?.text) ?? '');
  return texts.join('\n');
}

// What a record said or saw, for the message index and its snippets: typed text, the string inputs
// of every tool call, and every tool result, one block per line. Thinking blocks are skipped: they
// are neither what the user saw nor what the model committed to, and they are often redacted. A
// record with no message is a system record, whose `content` is the whole of what it said. A
// compaction summary yields no text, so it never reaches the message index: it restates the whole
// session and would otherwise answer almost every query; the same goes for the echo `/compact`
// prints. A tool call whose id is in `skip`, and the result answering it, yield no text either.
export function messageText(
  record: Record<string, unknown> | null,
  skip: ReadonlySet<string> = new Set(),
): string {
  if (record === null || record.isCompactSummary === true || isCompactEcho(record)) return '';
  const message = obj(record.message);
  if (message === null) return str(record.content) ?? '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => obj(b))
    .filter((b): b is Record<string, unknown> => b !== null)
    .filter((b) => !skip.has(str(b.id) ?? str(b.tool_use_id) ?? ''))
    .map(contentBlockText)
    .filter((t) => t !== '')
    .join('\n');
}

function contentBlockText(block: Record<string, unknown>): string {
  switch (str(block.type)) {
    case 'text':
      return str(block.text) ?? '';
    case 'tool_use':
      return Object.values(obj(block.input) ?? {})
        .filter((v): v is string => typeof v === 'string')
        .join('\n');
    case 'tool_result':
      return blockText(block);
    default:
      return '';
  }
}

// What `/compact` prints back into the transcript: a one-line notice, then the PreCompact hook's own
// stdout, which is the steering block. It restates instructions rather than anything the session
// did, so it is kept out of the index like a summary. The platform colours it, so the escape
// characters are dropped and the colour codes they introduced are allowed before the notice.
export function isCompactEcho(record: Record<string, unknown>): boolean {
  const content = obj(record.message)?.content;
  if (str(record.type) !== 'user' || typeof content !== 'string') return false;
  return /^<local-command-stdout>(?:\[[0-9;]*m)*Compacted\b/.test(content.replaceAll('\u001b', ''));
}

export function sebCallIds(records: (Record<string, unknown> | null)[]): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    const content = obj(record?.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const id = sebCallId(obj(block));
      if (id !== null) ids.add(id);
    }
  }
  return ids;
}

function sebCallId(block: Record<string, unknown> | null): string | null {
  if (block === null || str(block.type) !== 'tool_use' || str(block.name) !== 'Bash') return null;
  return isSebOnly(str(obj(block.input)?.command) ?? '') ? str(block.id) : null;
}

// A tool result's body: a string `content` as it is, an array `content` as its text blocks joined.
export function blockText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => str(obj(b)?.text) ?? '')
    .filter((t) => t !== '')
    .join('\n');
}

// Sentence scoring for the user-anchor quote cut: real decisions appear mid-message, so the
// key is the highest-scoring sentence, not the first one.
const IMPERATIVE_OPENERS = new Set([
  'use', 'add', 'remove', 'delete', 'make', 'keep', 'run', 'write', 'fix', 'stop', 'avoid',
  'prefer', 'ensure', 'check', 'update', 'rename', 'move', 'drop', 'implement', 'test',
  'commit', 'create', 'change', 'put', 'set', 'leave', 'skip', 'start', 'follow', 'read',
]);
const MODAL_TOKENS = new Set(['don', 'dont', 'never', 'must', 'always', 'only', 'instead', 'stop']);

export function selectQuote(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim() !== '');
  let best = sentences[0] ?? text;
  let bestScore = -1;
  for (const sentence of sentences) {
    const score = scoreSentence(sentence);
    if (score > bestScore) {
      best = sentence;
      bestScore = score;
    }
  }
  return truncateAtWord(best.trim(), 140);
}

function scoreSentence(sentence: string): number {
  const words = sentence.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w !== '');
  let score = 0;
  const opener = (words[0] ?? '').replace(/'/g, '');
  if (IMPERATIVE_OPENERS.has(opener)) score += 2;
  if (words.some((w) => MODAL_TOKENS.has(w.replace(/'/g, '')))) score += 2;
  score += Math.min(contentTokens(sentence).length, 5);
  return score;
}

export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, max)).trimEnd();
}

// ~4 characters per token. Every budget in Sebastian — the injected index and the CLI output cap —
// needs a deterministic estimate rather than tokenizer parity, and one estimate keeps a rendered
// string that fits an injection budget also fitting the same number of CLI tokens.
export const TOKEN_CHARS = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS);
}
