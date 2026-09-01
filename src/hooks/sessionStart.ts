import type { DatabaseSync } from 'node:sqlite';
import { latestCycle, logEvent, type CycleIndex } from '../store/db.js';
import {
  renderForgottenIndex, renderUnreconciledIndex, type RenderOptions,
} from '../reconcile/render.js';
import type { AnchorType } from '../transcript/anchors.js';
import { str } from '../transcript/text.js';
import type { Payload } from './runHook.js';

// The digest is the default spend; the full index is earned. A fixed 800 tokens every cycle can
// cost more context than it recovers, so only a cycle that lost a high-priority anchor pays it.
const DIGEST: RenderOptions = { tier: 'digest', budget: 150 };
const FULL: RenderOptions = { tier: 'full', budget: 800 };
const EARNS_FULL = new Set<AnchorType>(['error', 'edit']);

const RESUME_NOTE =
  'Sebastian archives this project\'s pre-compaction transcripts: `seb index` lists what the last summary dropped, `seb search <query>` finds an original.';

// Matcher `compact` injects the Forgotten Index; matcher `resume` injects one line saying the
// archive exists. An absent or unrecognized source takes the index path, which renders nothing
// when nothing was dropped — the safe direction, since a renamed field would otherwise silence
// injection with no symptom.
export function sessionStart(db: DatabaseSync, payload: Payload): string {
  if (source(payload) === 'resume') return additionalContext(RESUME_NOTE);
  const cycle = latestCycle(db, str(payload.session_id));
  if (cycle === null) {
    logEvent(db, 'session-start', 'info', 'no cycle to inject');
    return '';
  }
  const text = render(cycle);
  logEvent(
    db,
    'session-start',
    'info',
    `cycle ${cycle.cycle}: ${mode(cycle)} index, ${text.length} chars`,
  );
  return text === '' ? '' : additionalContext(text);
}

function source(payload: Payload): string | null {
  return str(payload.source) ?? str(payload.matcher);
}

// A reconciled cycle injects the index its drops earned. An unreconciled one injects the digest
// of its top-priority anchors: nothing is known dropped, so nothing has earned the full budget.
function render(cycle: CycleIndex): string {
  if (!cycle.reconciled) return renderUnreconciledIndex(cycle.anchors, DIGEST);
  return renderForgottenIndex(cycle.verdicts, cycle.anchors, tierFor(cycle));
}

function mode(cycle: CycleIndex): string {
  return cycle.reconciled ? tierFor(cycle).tier : 'unreconciled';
}

function tierFor(cycle: CycleIndex): RenderOptions {
  const dropped = new Set(
    cycle.verdicts.filter((v) => v.verdict === 'dropped').map((v) => v.anchorId),
  );
  const earned = cycle.anchors.some((a) => dropped.has(a.id) && EARNS_FULL.has(a.type));
  return earned ? FULL : DIGEST;
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
