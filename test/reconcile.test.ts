import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Anchor, AnchorType } from '../src/transcript/anchors.js';
import { reconcile } from '../src/reconcile/reconcile.js';
import type { Verdict } from '../src/reconcile/reconcile.js';
import { renderForgottenIndex, renderUnreconciledIndex } from '../src/reconcile/render.js';

const golden = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./golden/${name}`, import.meta.url)), 'utf8');

function anchor(id: string, type: AnchorType, turn: number, key: string, excerpt = ''): Anchor {
  return { id, uuid: `uuid-${id}`, sessionId: 's1', cycle: 0, turn, type, key, excerpt };
}

const NONE = new Set<string>();

// Matcher goldens. The eval harness scores reconciliation in aggregate over the corpus; each case
// here pins one measured false-alarm or false-negative class to an exact verdict, so a regression
// names the class it broke instead of moving an aggregate number. Every verdict carries its
// anchor's session id, because anchor ids are session-local and the store keys on
// (session_id, id).

describe('reconcile', () => {
  it('keeps a preserved-uuid anchor the summary never mentions, so material still in context verbatim is never flagged as lost', () => {
    const preserved = anchor('t3u1', 'user', 3, 'keep the retry logic out of the store layer');
    expect(reconcile([preserved], 'A summary about something else.', new Set(['uuid-t3u1']), NONE))
      .toEqual([{ anchorId: 't3u1', sessionId: 's1', verdict: 'kept', score: 1 }]);
  });

  it('keeps a platform-restored edit path without summary matching — the measured 96.6% edit false-drop class', () => {
    const restored = anchor('t5d1', 'edit', 5, 'src/store/db.ts');
    expect(reconcile([restored], 'A summary that never names the file.', NONE, new Set(['src/store/db.ts'])))
      .toEqual([{ anchorId: 't5d1', sessionId: 's1', verdict: 'kept', score: 1 }]);
  });

  it('stage 0b joins a relative bash-read key to its absolute restored path by suffix, but never a bare filename, whose collisions would hide a real drop', () => {
    const relative = anchor('t6r1', 'read', 6, 'src/store/db.ts');
    const bare = anchor('t7r1', 'read', 7, 'db.ts');
    const restored = new Set(['/repo/src/store/db.ts']);
    expect(reconcile([relative, bare], '', NONE, restored)).toEqual([
      { anchorId: 't6r1', sessionId: 's1', verdict: 'kept', score: 1 },
      { anchorId: 't7r1', sessionId: 's1', verdict: 'dropped', score: 0 },
    ]);
  });

  it('drops an edit anchor the summary names only by basename, and keeps a full-path mention at the mention score rather than as verbatim presence', () => {
    const summary = 'Work so far: edited db.ts to enable WAL, then src/steer/adapt.ts for the phrase table.';
    const basenameOnly = anchor('t8d1', 'edit', 8, 'src/store/db.ts');
    const fullPath = anchor('t11d1', 'edit', 11, 'src/steer/adapt.ts');
    expect(reconcile([basenameOnly, fullPath], summary, NONE, NONE)).toEqual([
      { anchorId: 't8d1', sessionId: 's1', verdict: 'dropped', score: 0 },
      { anchorId: 't11d1', sessionId: 's1', verdict: 'kept', score: 0.5 },
    ]);
  });

  it('keeps a paraphrased user decision by sentence containment where verbatim substring matching reports it dropped', () => {
    const decision = anchor('t14u1', 'user', 14, 'use tabs instead of spaces for all indentation in this repo');
    // Key tokens {use,tabs,instead,spaces,indentation,repo}, all 6 shared with the sentence, whose
    // set of 8 is the larger side: 6 over the smaller set of 6 = 1.0.
    const summary = 'User decision: use tabs instead of spaces for repo indentation. Other work followed.';
    expect(reconcile([decision], summary, NONE, NONE)).toEqual([
      { anchorId: 't14u1', sessionId: 's1', verdict: 'kept', score: 1 },
    ]);
  });

  it('scores a loose paraphrase into the uncertain band instead of kept, and keeps a score that lands exactly on the threshold', () => {
    const decision = anchor('t14u1', 'user', 14, 'use tabs instead of spaces for all indentation in this repo');
    // Key tokens {use,tabs,instead,spaces,indentation,repo}; sentence tokens
    // {team,preferred,tabs,across,repo} are the smaller set at 5; shared {tabs,repo} = 2/5 = 0.4.
    const loose = 'The team preferred tabs across the repo.';
    expect(reconcile([decision], loose, NONE, NONE)).toEqual([
      { anchorId: 't14u1', sessionId: 's1', verdict: 'dropped', score: 0.4 },
    ]);

    // The threshold keeps at exactly 0.5, and half a decision recovered is recovered. Sentence
    // tokens {team,chose,tabs,repo,indentation,generated,files} number 7, so the key's 6 are the
    // smaller set; shared {tabs,repo,indentation} = 3/6 = 0.5. An exclusive comparison here reads
    // as a drop and spends an index entry on material the summary still carries.
    const borderline = 'The team chose tabs for repo indentation only in generated files.';
    expect(reconcile([decision], borderline, NONE, NONE)).toEqual([
      { anchorId: 't14u1', sessionId: 's1', verdict: 'kept', score: 0.5 },
    ]);
  });

  it('drops an answer whose summary mentions the question topic but not the substance — matching the question key would report it kept', () => {
    const explanation = anchor('t20a1', 'answer', 20, 'available fts5 node',
      'FTS5 shipped in node sqlite from Node 22, and no 23 release has it.');
    // Against the excerpt tokens {fts5,shipped,node,sqlite,release}: topic-only shares {fts5,node},
    // 2 over the smaller set of 5 = 0.4. Against the question key {available,fts5,node} the same
    // sentence contains all 3 and would score 1.0 = kept.
    expect(reconcile([explanation], 'Discussed whether FTS5 is available in node builds.', NONE, NONE))
      .toEqual([{ anchorId: 't20a1', sessionId: 's1', verdict: 'dropped', score: 0.4 }]);
    expect(reconcile([explanation], 'FTS5 shipped in node sqlite from Node 22, and no 23 release has it.', NONE, NONE))
      .toEqual([{ anchorId: 't20a1', sessionId: 's1', verdict: 'kept', score: 1 }]);
  });

  it('scores a stopword-only prose key 0 rather than NaN, which would poison the drop-rate arithmetic steering consumes', () => {
    const short = anchor('t2u1', 'user', 2, 'why is this here');
    expect(reconcile([short], 'Why is this here.', NONE, NONE)).toEqual([
      { anchorId: 't2u1', sessionId: 's1', verdict: 'dropped', score: 0 },
    ]);
  });
});

// Renderer goldens, hand-written from the spec's Forgotten Index section. The eval measures index
// tokens and recall, never the rendered shape the model actually reads.

describe('renderForgottenIndex', () => {
  const anchors: Anchor[] = [
    anchor('t4e1', 'error', 4, 'typeerror cannot read properties of undefined reading config',
      "TypeError: cannot read properties of undefined (reading 'config')"),
    anchor('t7e1', 'error', 7, 'enoent no such file or directory sebastian.db',
      "ENOENT: no such file or directory, open 'sebastian.db'"),
    // The embedded newline is load-bearing: an answer excerpt is raw assistant prose, and the
    // goldens are single-line, so they fail if a newline survives into the rendered entry —
    // which would forge a phantom entry and an early footer inside additionalContext.
    anchor('t9a1', 'answer', 9, 'busy fts5 timeout wal',
      'WAL plus a 5-second busy timeout\nstops the second session failing instantly.'),
    anchor('t12d1', 'edit', 12, 'src/store/db.ts'),
    anchor('t15r1', 'read', 15, 'src/transcript/parse.ts'),
    anchor('t18w1', 'url', 18, 'https://example.com/docs/sqlite'),
    anchor('t21u1', 'user', 21, 'never commit generated files'),
    anchor('t24c1', 'cmd', 24, 'npm run build (exit 2)'),
    anchor('t27r2', 'read', 27, 'src/index.ts'),
  ];
  const dropped = (anchorId: string, score: number): Verdict =>
    ({ anchorId, sessionId: 's1', verdict: 'dropped', score });
  // t4e1/t7e1 are plain prose drops (score < 0.25), t9a1 sits in the uncertain band, the
  // identifiers are plain drops, and one read anchor is kept to keep the totals honest.
  const verdicts: Verdict[] = [
    dropped('t4e1', 0), dropped('t7e1', 0.12), dropped('t9a1', 0.4), dropped('t12d1', 0),
    dropped('t15r1', 0), dropped('t18w1', 0), dropped('t21u1', 0), dropped('t24c1', 0),
    { anchorId: 't27r2', sessionId: 's1', verdict: 'kept', score: 1 },
  ];

  it('lists every listable drop grouped by priority with the most recent first, and the band-2 entry under its verify-first heading', () => {
    expect(renderForgottenIndex(verdicts, anchors, 400)).toBe(golden('index-default.txt'));
  });

  // Round one holds one entry per type; the second error is the whole of round two. A budget that
  // fits round one and nothing more must cut that error, not the only edit, read, or url.
  it('a budget that fits one round cuts the second error before any other type\'s only entry', () => {
    expect(renderForgottenIndex(verdicts, anchors, 170)).toBe(golden('index-truncated.txt'));
  });

  // The degraded path. Nothing here may read as a loss claim: no verdict exists, so no anchor is
  // dropped, and the band headings that depend on a score must not appear either.
  it('labels a summary-less cycle unreconciled and bands none of its anchors, so an unchecked anchor is never presented as dropped', () => {
    expect(renderUnreconciledIndex(anchors, 400))
      .toBe(golden('index-unreconciled.txt'));
  });

  it('renders the empty string when nothing was dropped, so a lossless cycle injects nothing', () => {
    const allKept = verdicts.map((v): Verdict => ({ ...v, verdict: 'kept' }));
    expect(renderForgottenIndex(allKept, anchors, 400)).toBe('');
  });
});
