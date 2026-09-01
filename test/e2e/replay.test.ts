import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCaseIn } from '../../eval/harness.js';
import { loadCorpus } from '../../eval/metrics.js';
import { openDbAt } from '../../src/store/db.js';
import { search } from '../../src/cli/search.js';
import { show } from '../../src/cli/show.js';
import { computeSteering } from '../../src/steer/adapt.js';

// The replay runs through the eval harness's own case runner, so the product has one replay
// mechanism rather than two. The eval scores each stage of a cycle; nothing there asserts that the
// stages chain — that the anchor the index names is the anchor search finds, and that finding it
// changes what the next compaction is told. This test owns that chain.
//
// digest-overflow is the case that can carry it: its summary drops six of eight `read` anchors,
// which is the density a steering line needs before retrieval can escalate one.
const CORPUS = fileURLToPath(new URL('../../eval/corpus', import.meta.url));
const CASE_ID = 'digest-overflow';

function loadCase(): ReturnType<typeof loadCorpus>[number] {
  const found = loadCorpus(CORPUS).find((c) => c.id === CASE_ID);
  if (found === undefined) throw new Error(`the corpus no longer holds ${CASE_ID}`);
  return found;
}

const entryIds = (index: string): string[] =>
  index.split('\n').filter((l) => l.startsWith('- t')).map((l) => l.split(' ')[1] ?? '');

describe('one compaction cycle, injection through retrieval', () => {
  it('carries a dropped anchor from the injected index into search, and its retrieval into the next compaction\'s steering', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seb-replay-'));
    try {
      const result = runCaseIn(dir, loadCase());
      const ids = entryIds(result.injected);
      expect(ids.length).toBeGreaterThan(0);
      const first = ids[0] ?? '';

      const db = openDbAt(join(dir, 'eval.db'));
      const anchor = db.prepare('SELECT id, type, key, verdict FROM anchors WHERE id = ?').get(first);
      expect(anchor?.verdict).toBe('dropped');
      const id = String(anchor?.id);
      const key = String(anchor?.key);

      // Before retrieval the summarizer is told only what the drop-rate earned.
      const before = computeSteering(db);
      expect(before).toContain('keep every file path read');
      expect(before).not.toContain('Retrieved');

      // The index entry is a working handle: the key finds the anchor, and the id returns the
      // original record the summary no longer carries.
      expect(search(db, [key])).toContain(id);
      expect(show(db, [id])).toContain(key);

      // The retrieval is the signal the loop feeds forward.
      expect(computeSteering(db)).toMatch(/keep every file path read\. Retrieved \d+× after being dropped\./);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
