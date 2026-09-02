import type { DatabaseSync } from 'node:sqlite';
import { latestCycle, logEvent, recordInjection, type CycleIndex } from '../store/db.js';
import { renderForgottenIndex, renderUnreconciledIndex } from '../reconcile/render.js';
import { estimateTokens, str } from '../transcript/text.js';
import type { Payload } from './runHook.js';

// One ceiling for every injection. The renderer fills it one type at a time, so a cycle that lost
// a little spends a little, and a cycle that lost a lot still stops here.
const BUDGET = 400;

const RESUME_NOTE =
  'Sebastian archives this project\'s pre-compaction transcripts: `seb index` lists what the last summary dropped, `seb search <query>` finds an original.';

// Matcher `compact` injects the Forgotten Index; matcher `resume` injects one line saying the
// archive exists. An absent or unrecognized source takes the index path, which renders nothing
// when nothing was dropped — the safe direction, since a renamed field would otherwise silence
// injection with no symptom.
export function sessionStart(db: DatabaseSync, payload: Payload): string {
  const cycle = latestCycle(db, str(payload.session_id));
  if (source(payload) === 'resume') return resumeNote(db, cycle);
  if (cycle === null) {
    logEvent(db, 'session-start', 'info', 'no cycle to inject');
    return '';
  }
  const text = render(cycle);
  // What this cycle's index cost the context window, recorded before the text leaves the hook. An
  // empty render spends nothing and records 0, which is a measurement rather than a missing one.
  const tokens = text === '' ? 0 : estimateTokens(text);
  recordInjection(db, cycle.sessionId, cycle.cycle, tokens);
  logEvent(
    db,
    'session-start',
    'info',
    `cycle ${cycle.cycle}: ${cycle.reconciled ? 'reconciled' : 'unreconciled'} index, ` +
      `${text.length} chars, ${tokens} tokens injected`,
  );
  return text === '' ? '' : additionalContext(text);
}

// The note is Sebastian's cost too, so it is charged to the session's newest cycle. A session that
// has never compacted has no cycle to charge, and the note goes unrecorded.
function resumeNote(db: DatabaseSync, cycle: CycleIndex | null): string {
  if (cycle !== null) {
    recordInjection(db, cycle.sessionId, cycle.cycle, estimateTokens(RESUME_NOTE));
  }
  return additionalContext(RESUME_NOTE);
}

function source(payload: Payload): string | null {
  return str(payload.source) ?? str(payload.matcher);
}

// A reconciled cycle injects what its drops earned. An unreconciled one lists the cycle's anchors
// under the same ceiling, labelled so that nothing reads as a loss claim.
function render(cycle: CycleIndex): string {
  if (!cycle.reconciled) return renderUnreconciledIndex(cycle.anchors, BUDGET);
  return renderForgottenIndex(cycle.verdicts, cycle.anchors, BUDGET);
}

// SessionStart's injection channel. The whole payload is one JSON line on stdout.
function additionalContext(text: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: text,
    },
  })}\n`;
}
