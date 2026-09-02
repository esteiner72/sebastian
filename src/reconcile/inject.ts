import type { DatabaseSync } from 'node:sqlite';
import { logEvent, recordInjection, stampInjected, type CycleIndex } from '../store/db.js';
import { renderForgottenIndex, renderUnreconciledIndex } from './render.js';
import { estimateTokens } from '../transcript/text.js';

// One ceiling for every injection. The renderer fills it one type at a time, so a cycle that lost
// a little spends a little, and a cycle that lost a lot still stops here.
const BUDGET = 400;

// The injection channel for every hook that prints context. The whole payload is one JSON line on
// stdout, and the event name must match the hook that printed it.
export function additionalContext(event: string, text: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: text,
    },
  })}\n`;
}

// Renders one cycle's index, charges it, and marks it delivered.
//
// UserPromptSubmit is the loop's only injector, and it runs on every prompt; the `injected_at`
// stamp is what keeps a repeat prompt from spending the budget twice. An empty render is marked
// too: the cycle was considered and had nothing to report.
//
// A reconciled cycle injects what its drops earned. An unreconciled one lists the cycle's anchors
// under the same ceiling, labelled so that nothing reads as a loss claim.
export function deliverIndex(db: DatabaseSync, cycle: CycleIndex, hook: string, event: string): string {
  const text = cycle.reconciled
    ? renderForgottenIndex(cycle.verdicts, cycle.anchors, BUDGET)
    : renderUnreconciledIndex(cycle.anchors, BUDGET);
  const tokens = text === '' ? 0 : estimateTokens(text);
  recordInjection(db, cycle.sessionId, cycle.cycle, tokens);
  stampInjected(db, cycle.sessionId, cycle.cycle);
  logEvent(
    db,
    hook,
    'info',
    `cycle ${cycle.cycle}: ${cycle.reconciled ? 'reconciled' : 'unreconciled'} index, ` +
      `${text.length} chars, ${tokens} tokens injected`,
  );
  return text === '' ? '' : additionalContext(event, text);
}
