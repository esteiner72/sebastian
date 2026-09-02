import type { DatabaseSync } from 'node:sqlite';
import { latestCycle, logEvent, recordInjection, type CycleIndex } from '../store/db.js';
import { additionalContext } from '../reconcile/inject.js';
import { estimateTokens, str } from '../transcript/text.js';
import type { Payload } from './runHook.js';

const RESUME_NOTE =
  'Sebastian archives this project\'s pre-compaction transcripts: `seb index` lists what the last summary dropped, `seb search <query>` finds an original.';

const COMPACT_NOTE =
  'Sebastian archived this compaction. Its Forgotten Index is not ready yet: it arrives with your next message, or run `seb index` now.';

// Matcher `resume` injects one line saying the archive exists.
//
// Matcher `compact` injects one line saying the index is on its way. This hook runs before
// PostCompact, so the cycle the compaction just created is never recorded yet, and any settled cycle
// the session holds is a previous one. Injecting that would describe the wrong compaction under a
// header that reads "this cycle". UserPromptSubmit delivers the right one on the next message.
//
// Accepted consequence: a previous cycle that was reconciled but never injected stays undelivered,
// because UserPromptSubmit injects only the newest cycle. `seb index` still reaches it and
// `seb status` reports it. Delivering a two-summaries-old index as this cycle's is worse than not
// delivering it.
//
// The matcher sends `compact` and `resume` only. Any other source means the platform changed the
// field, and injecting on a guess would deliver the previous cycle's index as this one, so the hook
// stays silent and the log says why. UserPromptSubmit is the loop's only injector.
export function sessionStart(db: DatabaseSync, payload: Payload): string {
  const cycle = latestCycle(db, str(payload.session_id));
  const src = source(payload);
  if (src === 'resume') return resumeNote(db, cycle);
  if (src === 'compact') return compactNote(db, cycle);
  logEvent(db, 'session-start', 'info', `source ${src ?? 'absent'}: nothing to inject`);
  return '';
}

// A note is Sebastian's cost too, so it is charged to the session's newest cycle. A session that
// has never compacted has no cycle to charge, and the note goes unrecorded. A note never marks the
// cycle delivered: it is not the index, and the index still has to reach the model.
function resumeNote(db: DatabaseSync, cycle: CycleIndex | null): string {
  chargeNote(db, cycle, RESUME_NOTE);
  return additionalContext('SessionStart', RESUME_NOTE);
}

function compactNote(db: DatabaseSync, cycle: CycleIndex | null): string {
  chargeNote(db, cycle, COMPACT_NOTE);
  logEvent(db, 'session-start', 'info', 'compaction not yet settled; note injected');
  return additionalContext('SessionStart', COMPACT_NOTE);
}

function chargeNote(db: DatabaseSync, cycle: CycleIndex | null, note: string): void {
  if (cycle === null) return;
  recordInjection(db, cycle.sessionId, cycle.cycle, estimateTokens(note));
}

function source(payload: Payload): string | null {
  return str(payload.source) ?? str(payload.matcher);
}
