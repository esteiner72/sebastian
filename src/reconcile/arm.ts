import { createHash } from 'node:crypto';

// The experiment arm a session belongs to: `index` sessions get the Forgotten Index, `pointer`
// sessions get only the pointer to `seb search`. A pure function of the session id, because
// PreCompact writes steering before any cycle row exists and every hook must agree without shared
// state. A resumed session keeps its id and so its arm. Changing this mid-experiment reshuffles
// the arms; the golden in test/golden/arm-assignment.txt pins it.
//
// SEBASTIAN_ARM set to `index` or `pointer` overrides the hash for every session. The eval harness
// sets `index`, because it scores the index, and a user can set it to opt out of the experiment.
export type Arm = 'index' | 'pointer';

export function armFor(sessionId: string): Arm {
  const forced = process.env.SEBASTIAN_ARM;
  if (forced === 'index' || forced === 'pointer') return forced;
  const first = createHash('sha256').update(sessionId, 'utf8').digest()[0] ?? 0;
  return first % 2 === 0 ? 'index' : 'pointer';
}
