import type { Anchor, AnchorType } from '../transcript/anchors.js';
import { truncateAtWord } from '../transcript/text.js';
import type { Verdict } from './reconcile.js';

export interface RenderOptions {
  tier: 'digest' | 'full';
  budget: number;
}

// Injection priority. `user` and `cmd` drops are counted and archived but never spend injected
// tokens: a dropped cmd is a weak loss signal, and `user` is demoted until retrieval telemetry
// earns it a slot. The digest caps entries; the full tier fits as many as the budget allows.
const PRIORITY: AnchorType[] = ['error', 'answer', 'edit', 'user', 'cmd', 'read', 'url'];
const LISTED = new Set<AnchorType>(['error', 'answer', 'edit', 'read', 'url']);
const PROSE = new Set<AnchorType>(['error', 'answer', 'user']);
const DIGEST_ENTRY_CAP = 5;

// Bands are presentation-only: identifiers and negligible-overlap prose list plainly, while a
// near-miss on token overlap is the paraphrase signature and lists under a verify-first heading.
const UNCERTAIN_MIN = 0.25;
const UNCERTAIN_MAX = 0.5;

const HEADER = '## Forgotten Index';
const UNCERTAIN_HEADING = 'Possibly paraphrased — verify against the summary before retrieving:';
const FOOTER = 'Run `seb index --dropped` for the full list; `seb show <id>` retrieves an original.';

interface Entry {
  anchor: Anchor;
  score: number;
}

export function renderForgottenIndex(
  verdicts: Verdict[],
  anchors: Anchor[],
  opts: RenderOptions,
): string {
  const dropped = joinDropped(verdicts, anchors);
  if (dropped.length === 0) return '';
  const cap = opts.tier === 'digest' ? DIGEST_ENTRY_CAP : Infinity;
  const entries = dropped
    .filter((d) => LISTED.has(d.anchor.type))
    .sort(byPriority)
    .slice(0, cap);
  return fitToBudget(entries, countsLine(dropped, verdicts.length), opts.budget);
}

function joinDropped(verdicts: Verdict[], anchors: Anchor[]): Entry[] {
  const byId = new Map(anchors.map((a) => [a.id, a]));
  const dropped: Entry[] = [];
  for (const v of verdicts) {
    const anchor = byId.get(v.anchorId);
    if (v.verdict === 'dropped' && anchor !== undefined) dropped.push({ anchor, score: v.score });
  }
  return dropped;
}

function byPriority(a: Entry, b: Entry): number {
  const rank = PRIORITY.indexOf(a.anchor.type) - PRIORITY.indexOf(b.anchor.type);
  return rank !== 0 ? rank : a.anchor.turn - b.anchor.turn;
}

// The counts line covers every dropped type, including the count-only ones — a non-zero user
// count with the `seb index` pointer is how a dropped instruction stays reachable while spending
// no entry tokens on it.
function countsLine(dropped: Entry[], total: number): string {
  const counts = new Map<AnchorType, number>();
  for (const d of dropped) counts.set(d.anchor.type, (counts.get(d.anchor.type) ?? 0) + 1);
  const parts = PRIORITY.filter((t) => counts.has(t)).map((t) => `${counts.get(t)} ${t}`);
  return `Dropped this cycle: ${parts.join(', ')} (${total} anchors reconciled).`;
}

// Lowest-priority entries are cut first until the estimate fits the budget; the header, counts,
// and pointer always render, so an over-budget cycle still reports what it cannot list.
function fitToBudget(entries: Entry[], counts: string, budget: number): string {
  for (let n = entries.length; n > 0; n -= 1) {
    const text = renderText(entries.slice(0, n), counts);
    if (estimateTokens(text) <= budget) return text;
  }
  return renderText([], counts);
}

function renderText(entries: Entry[], counts: string): string {
  const plain = entries.filter((d) => !isUncertain(d)).map(entryLine);
  const uncertain = entries.filter(isUncertain).map(entryLine);
  const lines = [HEADER, counts, ...plain];
  if (uncertain.length > 0) lines.push(UNCERTAIN_HEADING, ...uncertain);
  lines.push(FOOTER);
  return `${lines.join('\n')}\n`;
}

function isUncertain(d: Entry): boolean {
  return PROSE.has(d.anchor.type) && d.score >= UNCERTAIN_MIN && d.score < UNCERTAIN_MAX;
}

// Prose entries display the verbatim excerpt (an error's raw signature, an answer's opening);
// identifier entries display the key itself. Every entry carries the exact retrieval command.
// Whitespace collapses to single spaces first: an answer excerpt is raw assistant prose, and a
// newline inside it would forge extra index entries — and an early footer — in additionalContext.
function entryLine(d: Entry): string {
  const a = d.anchor;
  const display = PROSE.has(a.type) ? a.excerpt : a.key;
  const flat = display.replaceAll(/\s+/g, ' ').trim();
  return `- ${a.id} ${a.type}: ${truncateAtWord(flat, 120)} — seb show ${a.id}`;
}

// ~4 characters per token: a budget needs a deterministic estimate, not tokenizer parity.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
