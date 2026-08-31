import type { Anchor } from '../transcript/anchors.js';
import { contentTokens } from '../transcript/text.js';

export interface Verdict {
  anchorId: string;
  verdict: 'kept' | 'dropped';
  score: number;
}

// Identifier types match by substring containment; prose types match by Jaccard overlap against
// the best summary sentence. Real summaries paraphrase rather than quote, so verbatim matching on
// prose would report almost every user anchor as dropped, every cycle.
const IDENTIFIER_TYPES = new Set(['edit', 'read', 'cmd', 'url']);
const KEEP_THRESHOLD = 0.5;

// Stages, in order: exact keeps from the boundary's ground truth (preserved-verbatim message
// uuids, then platform-restored file paths), then text matching against the summary. Only anchors
// from replaced messages ever reach the matcher.
export function reconcile(
  anchors: Anchor[],
  summary: string,
  preservedUuids: Set<string>,
  restoredPaths: Set<string>,
): Verdict[] {
  const normSummary = normalize(summary);
  const sentences = sentenceTokenSets(summary);
  return anchors.map((anchor) => {
    if (preservedUuids.has(anchor.uuid)) return kept(anchor, 1);
    if ((anchor.type === 'edit' || anchor.type === 'read') && wasRestored(anchor.key, restoredPaths)) {
      return kept(anchor, 1);
    }
    return IDENTIFIER_TYPES.has(anchor.type)
      ? identifierVerdict(anchor, normSummary)
      : proseVerdict(anchor, sentences);
  });
}

// Restored paths are absolute attachment filenames, while a read anchor extracted from a Bash
// operand carries the operand verbatim, which is usually relative — an exact test can never join
// the two, and it under-fires this stage by about a quarter. A key containing a slash also matches
// by path suffix. A bare filename never does: that degenerates into basename matching, whose
// cross-tree collisions would assert kept at score 1.0 and permanently hide a genuine drop.
function wasRestored(key: string, restoredPaths: Set<string>): boolean {
  if (restoredPaths.has(key)) return true;
  if (!key.includes('/')) return false;
  const suffix = `/${key}`;
  for (const path of restoredPaths) if (path.endsWith(suffix)) return true;
  return false;
}

function kept(anchor: Anchor, score: number): Verdict {
  return { anchorId: anchor.id, verdict: 'kept', score };
}

// Containment of the normalized key; a path whose full form is absent falls back to its basename,
// so `src/store/db.ts` counts as kept when the summary says `db.ts`. A bare path mention therefore
// reads as kept even when the surrounding detail was dropped — a known, accepted false positive:
// paths are not paraphrased, and identifiers are what steering tells the summarizer to keep.
function identifierVerdict(anchor: Anchor, normSummary: string): Verdict {
  const key = stripPunct(normalize(anchor.key));
  if (key !== '' && normSummary.includes(key)) return kept(anchor, 1);
  const base = anchor.key.includes('/') ? stripPunct(normalize(basename(anchor.key))) : '';
  if (base !== '' && normSummary.includes(base)) return kept(anchor, 1);
  return { anchorId: anchor.id, verdict: 'dropped', score: 0 };
}

// `answer` matches on the answer's own prose (the excerpt), never the question key: a summary
// that mentions the topic without the substance must read as dropped, which is the loss this
// anchor type exists to catch. `error` and `user` match on their normalized keys.
function proseVerdict(anchor: Anchor, sentences: Set<string>[]): Verdict {
  const source = anchor.type === 'answer' ? anchor.excerpt : anchor.key;
  const tokens = new Set(contentTokens(source));
  let best = 0;
  for (const sentence of sentences) best = Math.max(best, containment(tokens, sentence));
  return { anchorId: anchor.id, verdict: best >= KEEP_THRESHOLD ? 'kept' : 'dropped', score: best };
}

// Containment, not Jaccard: shared tokens over the smaller set. A union denominator has a
// structural ceiling — an answer excerpt carries ~27 content tokens and a median summary sentence
// 9–12, so union-Jaccard stays under 0.5 even when the sentence is contained entirely — which
// would pin error and answer drop-rates at 1.0 and turn their steering lines into constants.
// min() leaves sentence-sized user keys scoring as Jaccard had them. An empty side scores 0,
// never NaN, because the score feeds drop-rate arithmetic in steering.
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function normalize(text: string): string {
  return text.toLowerCase().replaceAll(/\s+/g, ' ').trim();
}

function stripPunct(text: string): string {
  return text.replaceAll(/^[^a-z0-9/]+|[^a-z0-9/]+$/g, '');
}

function basename(path: string): string {
  return path.split('/').filter((s) => s !== '').pop() ?? '';
}

function sentenceTokenSets(summary: string): Set<string>[] {
  return summary
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => new Set(contentTokens(s)))
    .filter((s) => s.size > 0);
}
