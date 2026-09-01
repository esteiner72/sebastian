import type { Anchor, AnchorType } from '../transcript/anchors.js';
import { estimateTokens, truncateAtWord } from '../transcript/text.js';
import type { Verdict } from './reconcile.js';

// Injection priority. `user` and `cmd` drops are counted and archived but never spend injected
// tokens: a dropped cmd is a weak loss signal, and `user` is demoted until retrieval telemetry
// earns it a slot.
const PRIORITY: AnchorType[] = ['error', 'answer', 'edit', 'user', 'cmd', 'read', 'url'];
const LISTED = new Set<AnchorType>(['error', 'answer', 'edit', 'read', 'url']);
const PROSE = new Set<AnchorType>(['error', 'answer', 'user']);

// Bands are presentation-only: identifiers and negligible-overlap prose list plainly, while a
// near-miss on token overlap is the paraphrase signature and lists under a verify-first heading.
export const UNCERTAIN_MIN = 0.25;
export const UNCERTAIN_MAX = 0.5;

const UNCERTAIN_HEADING = 'Possibly paraphrased — verify against the summary before retrieving:';

// The header, the line under it, and the pointer that closes the block. All three always render,
// so a cycle whose entries do not fit the budget still says what it holds and where to look.
interface Chrome {
  header: string;
  note: string;
  footer: string;
}

const DROPPED_CHROME = {
  header: '## Forgotten Index',
  footer: 'Run `seb index --dropped` for the full list; `seb show <id>` retrieves an original.',
};

const UNRECONCILED_CHROME: Chrome = {
  header: '## Forgotten Index — unreconciled',
  note: 'No summary reached Sebastian for this compaction, so these anchors were never checked against one. Each existed before the boundary; whether the summary kept it is unknown.',
  footer: 'Check each against the summary you hold; `seb show <id>` retrieves an original, and `seb timeline` maps the cycle.',
};

interface Entry {
  anchor: Anchor;
  score: number;
}

export function renderForgottenIndex(verdicts: Verdict[], anchors: Anchor[], budget: number): string {
  const dropped = joinDropped(verdicts, anchors);
  if (dropped.length === 0) return '';
  const entries = dropped.filter((d) => LISTED.has(d.anchor.type));
  const chrome = { ...DROPPED_CHROME, note: countsLine(dropped, verdicts.length) };
  return fitToBudget(entries, chrome, budget);
}

// The degraded path: PostCompact never saw a summary, so no anchor carries a verdict. The cycle's
// listable anchors still list, because a reader who knows what existed before the boundary can
// check the summary itself — but nothing here claims a loss, and the counts line is replaced by
// the reason there is none.
export function renderUnreconciledIndex(anchors: Anchor[], budget: number): string {
  const entries = anchors
    .filter((a) => LISTED.has(a.type))
    .map((anchor) => ({ anchor, score: 0 }));
  if (entries.length === 0) return '';
  return fitToBudget(entries, UNRECONCILED_CHROME, budget);
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

// Display order: grouped by type in priority order, most recent turn first within a type.
function byPriority(a: Entry, b: Entry): number {
  const rank = PRIORITY.indexOf(a.anchor.type) - PRIORITY.indexOf(b.anchor.type);
  return rank !== 0 ? rank : b.anchor.turn - a.anchor.turn;
}

// Fill order: one entry per type per round, types in priority order, most recent first within a
// type. Truncation cuts from the end of this order, so the latest round goes first and a type with
// many drops can never starve a type with one.
function roundRobin(entries: Entry[]): Entry[] {
  const sorted = [...entries].sort(byPriority);
  const queues = PRIORITY.map((type) => sorted.filter((e) => e.anchor.type === type));
  const order: Entry[] = [];
  for (let round = 0; queues.some((q) => q.length > round); round += 1) {
    for (const queue of queues) {
      const entry = queue[round];
      if (entry !== undefined) order.push(entry);
    }
  }
  return order;
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

// Entries are taken in fill order and cut from its end until the estimate fits the budget; the
// header, counts, and pointer always render, so an over-budget cycle still reports what it cannot
// list. What survives renders in display order.
//
// The cut is found by binary search, which the render permits: one more entry appends one line, and
// at most once the uncertain heading, so the rendered length never falls as the count rises.
function fitToBudget(entries: Entry[], chrome: Chrome, budget: number): string {
  const fill = roundRobin(entries);
  const firstN = (n: number): string => renderText(fill.slice(0, n).sort(byPriority), chrome);
  let low = 0;
  let high = fill.length;
  let best = firstN(0);
  while (low < high) {
    const n = Math.ceil((low + high) / 2);
    const text = firstN(n);
    if (estimateTokens(text) <= budget) {
      best = text;
      low = n;
    } else {
      high = n - 1;
    }
  }
  return best;
}

function renderText(entries: Entry[], chrome: Chrome): string {
  const plain = entries.filter((d) => !isUncertain(d)).map(entryLine);
  const uncertain = entries.filter(isUncertain).map(entryLine);
  const lines = [chrome.header, chrome.note, ...plain];
  if (uncertain.length > 0) lines.push(UNCERTAIN_HEADING, ...uncertain);
  lines.push(chrome.footer);
  return `${lines.join('\n')}\n`;
}

function isUncertain(d: Entry): boolean {
  return PROSE.has(d.anchor.type) && d.score >= UNCERTAIN_MIN && d.score < UNCERTAIN_MAX;
}

// Every entry carries the exact retrieval command.
function entryLine(d: Entry): string {
  const a = d.anchor;
  return `- ${a.id} ${a.type}: ${anchorDisplay(a)} — seb show ${a.id}`;
}

// What an anchor shows on one line, here and in the CLI. Prose entries display the verbatim
// excerpt (an error's raw signature, an answer's opening); identifier entries display the key
// itself. Whitespace collapses to single spaces first: an answer excerpt is raw assistant prose,
// and a newline inside it would forge extra entries — and an early footer — in a line-oriented
// reader such as additionalContext.
export function anchorDisplay(a: Anchor): string {
  const display = PROSE.has(a.type) ? a.excerpt : a.key;
  return truncateAtWord(display.replaceAll(/\s+/g, ' ').trim(), 120);
}
