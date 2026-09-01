import type { Anchor } from '../transcript/anchors.js';
import { contentTokens } from '../transcript/text.js';

// `sessionId` travels with the verdict because anchor ids are session-local and the anchors table
// keys on (session_id, id): a bare anchor id cannot address a row in a project-scoped database.
export interface Verdict {
  anchorId: string;
  sessionId: string;
  verdict: 'kept' | 'dropped';
  score: number;
}

// Identifier types match by substring containment; prose types match by Jaccard overlap against
// the best summary sentence. Real summaries paraphrase rather than quote, so verbatim matching on
// prose would report almost every user anchor as dropped, every cycle.
const IDENTIFIER_TYPES = new Set(['edit', 'read', 'cmd', 'url']);
const KEEP_THRESHOLD = 0.5;

// A summary that names an identifier held its identity, not its content. The verdict is kept, the
// score says which kind of keep it was: Stage 0 and 0b keeps are verbatim presence at 1.0.
const MENTION_SCORE = 0.5;

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
  return { anchorId: anchor.id, sessionId: anchor.sessionId, verdict: 'kept', score };
}

function dropped(anchor: Anchor, score: number): Verdict {
  return { anchorId: anchor.id, sessionId: anchor.sessionId, verdict: 'dropped', score };
}

// Containment of the full normalized key, and nothing looser: a basename fallback would rule
// `src/store/db.ts` kept when the summary says `db.ts`, and a URL kept on its last path segment.
function identifierVerdict(anchor: Anchor, normSummary: string): Verdict {
  const key = stripPunct(normalize(anchor.key));
  if (key !== '' && normSummary.includes(key)) return kept(anchor, MENTION_SCORE);
  return dropped(anchor, 0);
}

// `answer` matches on the answer's own prose (the excerpt), never the question key: a summary
// that mentions the topic without the substance must read as dropped, which is the loss this
// anchor type exists to catch. `error` and `user` match on their normalized keys.
function proseVerdict(anchor: Anchor, sentences: Set<string>[]): Verdict {
  const source = anchor.type === 'answer' ? anchor.excerpt : anchor.key;
  const tokens = new Set(contentTokens(source));
  let best = 0;
  for (const sentence of sentences) best = Math.max(best, containment(tokens, sentence));
  return best >= KEEP_THRESHOLD ? kept(anchor, best) : dropped(anchor, best);
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


function sentenceTokenSets(summary: string): Set<string>[] {
  return summary
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => new Set(contentTokens(s)))
    .filter((s) => s.size > 0);
}
