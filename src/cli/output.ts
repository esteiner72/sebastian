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
