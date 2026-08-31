import type { TranscriptEvent } from './parse.js';

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
// variation do not split identical questions.
export function questionKey(text: string): string {
  return [...new Set(contentTokens(text))].sort().join(' ');
}

// Openers that mark a question on their own. `do` is the one auxiliary left out, measured over
// 227 transcripts and 1,351 genuine user messages: every `do` opener without a `?` is an
// imperative ("Do #2 while I sort out the access issue"), while every other auxiliary opener
// without a `?` is a question, `can` alone accounting for 62 of them. `do` still qualifies
// through the trailing `?`. A directive misread as a question surrenders its verbatim quote and
// points `seb show` at the reply instead of the instruction, so the split is worth measuring.
const INTERROGATIVES = new Set([
  'what', 'why', 'how', 'when', 'which', 'who', 'is', 'are', 'does', 'can', 'should',
]);

export function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith('?')) return true;
  const first = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  return INTERROGATIVES.has(first.replace(/[^a-z]/g, ''));
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
  const text = messageText(content);
  if (text === null) return null;
  const stripped = stripEnvelopes(text);
  return stripped === '' ? null : stripped;
}

function messageText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const blocks = content.map((b) => obj(b));
  if (blocks.some((b) => str(b?.type) === 'tool_result')) return null;
  const texts = blocks.filter((b) => str(b?.type) === 'text').map((b) => str(b?.text) ?? '');
  return texts.join('\n');
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
