import { anchorDisplay } from '../reconcile/render.js';
import { estimateTokens, TOKEN_CHARS } from '../transcript/text.js';
import type { Anchor } from '../transcript/anchors.js';

// Every command answers into the model's context window, so output is bounded the same way the
// injected index is. The cap covers the listing a command produces; its heading and its retrieval
// pointer ride outside it, because a truncated pointer helps nobody.
export const OUTPUT_TOKENS = 2000;

const DEFAULT_HINT = 'a narrower query';

// Whole lines only, and the footer's room is reserved before the first line is kept, so the
// returned text carries its own count of what it left out. A listing renders one line per result,
// which makes `N more` a count of results rather than of bytes.
export function capOutput(text: string, tokens: number, hint: string = DEFAULT_HINT): string {
  if (estimateTokens(text) <= tokens) return text;
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const room = (tokens - estimateTokens(footer(lines.length, hint))) * TOKEN_CHARS;
  let chars = 0;
  let kept = 0;
  for (const line of lines) {
    if (chars + line.length + 1 > room) break;
    chars += line.length + 1;
    kept += 1;
  }
  const body = lines.slice(0, kept).map((line) => `${line}\n`).join('');
  return `${body}${footer(lines.length - kept, hint)}`;
}

function footer(omitted: number, hint: string): string {
  return `… ${omitted} more — refine with ${hint}.\n`;
}

// Ids are session-local, so a result set drawn from two sessions carries two `t41e1`s. The 8-
// character session prefix disambiguates them for a reader, and `seb show` accepts it back — but
// it is display only, and a single-session result set never pays for it.
export function spansSessions(anchors: { sessionId: string }[]): boolean {
  return new Set(anchors.map((a) => a.sessionId)).size > 1;
}

export function displayId(sessionId: string, id: string, qualified: boolean): string {
  return qualified ? `${sessionId.slice(0, 8)}/${id}` : id;
}

// One anchor, one line: what it is, which cycle lost it, and enough of its content to judge
// whether it is worth retrieving. The turn is already in the id, so only the cycle is spelled out.
export function anchorLine(a: Anchor, qualified: boolean, suffix = ''): string {
  return `${displayId(a.sessionId, a.id, qualified)} ${a.type} c${a.cycle}${suffix} — ${anchorDisplay(a)}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// The window of a hit's text that a listing shows: it opens shortly before the first query token,
// runs past it, and slides left to fill itself, so a text shorter than the window renders whole.
// Each edge moves to the nearest whitespace within a short slack, so the window opens and closes on
// a word without a long unbroken token, a URL or a JSON run, costing most of it. Whitespace collapses
// to single spaces. Computed here rather than by FTS5's snippet(), so a golden can be derived by hand.
export function snippetAround(text: string, tokens: string[], before = 60, after = 200): string {
  const idx = firstMatch(text.toLowerCase(), tokens.map((t) => t.toLowerCase()));
  const start = openOnWord(text, Math.max(0, Math.min(idx - before, text.length - (before + after))));
  const cut = idx + after < text.length;
  const end = cut ? closeOnWord(text, idx + after) : text.length;
  const window = text.slice(start, end).replaceAll(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${window}${cut ? '…' : ''}`;
}

const WORD_SLACK = 40;

// FTS5 can match through diacritic folding where a plain substring search does not, and then the
// window opens at the start of the text.
function firstMatch(lower: string, tokens: string[]): number {
  const found = tokens.map((t) => lower.indexOf(t)).filter((i) => i !== -1);
  return found.length === 0 ? 0 : Math.min(...found);
}

function openOnWord(text: string, start: number): number {
  if (start === 0) return 0;
  const space = text.slice(start, start + WORD_SLACK).search(/\s/);
  return space === -1 ? start : start + space + 1;
}

function closeOnWord(text: string, end: number): number {
  const from = Math.max(0, end - WORD_SLACK);
  const space = text.slice(from, end + 1).search(/\s\S*$/);
  return space === -1 ? end : from + space;
}
