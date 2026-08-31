import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { logTelemetry, openDbAt } from '../src/store/db.js';
import { computeSteering } from '../src/steer/adapt.js';

const golden = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./golden/${name}`, import.meta.url)), 'utf8');

const tempDb = (): DatabaseSync =>
  openDbAt(join(mkdtempSync(join(tmpdir(), 'seb-steer-')), 'sebastian.db'));

// Hand-derived verdict counts, and the arithmetic each one pins:
//   error  6 dropped of  8 reconciled = 0.75 — earns a line, and sorts first
//   edit   6 dropped of 10 reconciled = 0.60 — earns a line, and sorts second
//   read   3 dropped of  6 reconciled = 0.50 — exactly the threshold, so no line
//   user   4 dropped of  4 reconciled = 1.00 — below 5 observed, so no line
//   cmd    6 dropped of  6 reconciled = 1.00 — excluded by type: a command-line key never appears
//          in a summary, so this line would otherwise print every cycle forever
// The pending error anchors carry no verdict and belong to neither count: counting them would
// read error as 6 of 11.
const FIXTURE = [
  { type: 'error', dropped: 6, kept: 2, pending: 3 },
  { type: 'edit', dropped: 6, kept: 4, pending: 0 },
  { type: 'read', dropped: 3, kept: 3, pending: 0 },
  { type: 'user', dropped: 4, kept: 0, pending: 0 },
  { type: 'cmd', dropped: 6, kept: 0, pending: 0 },
];

const repeat = (n: number, verdict: string | null): (string | null)[] =>
  Array.from({ length: n }, () => verdict);

// Anchors carry a foreign key into messages, which node:sqlite enforces by default, so every
// anchor points at one archived message.
function seedVerdicts(db: DatabaseSync): void {
  db.prepare(
    'INSERT INTO messages (uuid, session_id, cycle, turn, record) VALUES (?, ?, ?, ?, ?)',
  ).run('m1', 's1', 0, 1, '{}');
  const insert = db.prepare(
    'INSERT INTO anchors (id, uuid, session_id, cycle, turn, type, key, excerpt, verdict) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  let n = 0;
  for (const c of FIXTURE) {
    const verdicts = [
      ...repeat(c.dropped, 'dropped'),
      ...repeat(c.kept, 'kept'),
      ...repeat(c.pending, null),
    ];
    for (const verdict of verdicts) {
      n += 1;
      insert.run(`a${n}`, 'm1', 's1', 0, n, c.type, `key-${n}`, '', verdict);
    }
  }
}

// Steering goldens, hand-written from the spec's Steering text section. The eval harness scores
// steering lift as one aggregate number over the corpus; these pin the exact thresholds, the
// ordering, and the directive phrasing that the aggregate cannot name when it moves.

describe('computeSteering', () => {
  it('emits the four base lines alone from a database holding no verdicts, so the first compaction of a project cannot print a rate divided by zero observations', () => {
    const db = tempDb();
    expect(computeSteering(db)).toBe(golden('steering-base.txt'));
    db.close();
  });

  it('earns a line only above a 0.5 drop-rate with at least 5 reconciled anchors, so an exactly-half type, a four-anchor sweep, and a total cmd sweep all stay silent', () => {
    const db = tempDb();
    seedVerdicts(db);
    expect(computeSteering(db)).toBe(golden('steering-droprate.txt'));
    db.close();
  });

  it('escalates only a line drop-rate already earned, so retrieval telemetry on an unearned type adds no line and a zero-hit search adds no count', () => {
    const db = tempDb();
    seedVerdicts(db);
    // Four error retrievals returned rows; the fifth returned none, so it retrieved nothing.
    logTelemetry(db, { cmd: 'search', anchorType: 'error', hits: 3 });
    logTelemetry(db, { cmd: 'show', anchorType: 'error', hits: 1 });
    logTelemetry(db, { cmd: 'search', anchorType: 'error', hits: 2 });
    logTelemetry(db, { cmd: 'show', anchorType: 'error', hits: 1 });
    logTelemetry(db, { cmd: 'search', anchorType: 'error', hits: 0 });
    // Only search and show are retrievals: an `index` listing that touches a type must not
    // escalate its line, or every future typed command inflates the multiplier.
    logTelemetry(db, { cmd: 'index', anchorType: 'error', hits: 5 });
    // `read` sits below the drop-rate threshold, so its retrievals are a multiplier over nothing.
    logTelemetry(db, { cmd: 'search', anchorType: 'read', hits: 4 });
    logTelemetry(db, { cmd: 'show', anchorType: 'read', hits: 1 });
    logTelemetry(db, { cmd: 'status', hits: 0 });

    expect(computeSteering(db)).toBe(golden('steering-retrieval.txt'));
    db.close();
  });
});
