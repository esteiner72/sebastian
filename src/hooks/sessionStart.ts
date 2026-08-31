import type { DatabaseSync } from 'node:sqlite';
import { latestReconciledCycle, logEvent, type ReconciledCycle } from '../store/db.js';
import { renderForgottenIndex, type RenderOptions } from '../reconcile/render.js';
import type { AnchorType } from '../transcript/anchors.js';
import { str } from '../transcript/text.js';
import type { Payload } from './runHook.js';

// The digest is the default spend; the full index is earned. A fixed 800 tokens every cycle can
// cost more context than it recovers, so only a cycle that lost a high-priority anchor pays it.
const DIGEST_BUDGET = 150;
const FULL_BUDGET = 800;
const EARNS_FULL = new Set<AnchorType>(['error', 'edit']);

const RESUME_NOTE =
  'Sebastian archives this project\'s pre-compaction transcripts: `seb index` lists what the last summary dropped, `seb search <query>` finds an original.';

// Matcher `compact` injects the Forgotten Index; matcher `resume` injects one line saying the
// archive exists. An absent or unrecognized source takes the index path, which renders nothing
// when nothing was dropped — the safe direction, since a renamed field would otherwise silence
// injection with no symptom.
export function sessionStart(db: DatabaseSync, payload: Payload): string {
  if (source(payload) === 'resume') return additionalContext(RESUME_NOTE);
  const cycle = latestReconciledCycle(db, str(payload.session_id));
  if (cycle === null) {
    logEvent(db, 'session-start', 'info', 'no reconciled cycle to inject');
    return '';
  }
  const opts = tierFor(cycle);
  const text = renderForgottenIndex(cycle.verdicts, cycle.anchors, opts);
  logEvent(
    db,
    'session-start',
    'info',
    `cycle ${cycle.cycle}: ${opts.tier} index, ${text.length} chars`,
  );
  return text === '' ? '' : additionalContext(text);
}

function source(payload: Payload): string | null {
  return str(payload.source) ?? str(payload.matcher);
}

function tierFor(cycle: ReconciledCycle): RenderOptions {
  const dropped = new Set(
    cycle.verdicts.filter((v) => v.verdict === 'dropped').map((v) => v.anchorId),
  );
  const earned = cycle.anchors.some((a) => dropped.has(a.id) && EARNS_FULL.has(a.type));
  return earned ? { tier: 'full', budget: FULL_BUDGET } : { tier: 'digest', budget: DIGEST_BUDGET };
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
