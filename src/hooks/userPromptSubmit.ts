import type { DatabaseSync } from 'node:sqlite';
import { hasPending, latestCycle, logEvent } from '../store/db.js';
import { catchUp } from '../reconcile/cycle.js';
import { deliverIndex } from '../reconcile/inject.js';
import { parseTranscript } from '../transcript/parse.js';
import { str } from '../transcript/text.js';
import { resolveTranscript, type Payload } from './runHook.js';

// The loop's injection point, and its last chance to close a cycle.
//
// SessionStart runs before PostCompact, and PostCompact runs before Claude Code appends the
// boundary record, so neither is guaranteed to see a compaction it observed. This hook runs on the
// user's next message: the record is on disk by then, and its output reaches the model's next turn.
export function userPromptSubmit(db: DatabaseSync, payload: Payload): string {
  const sessionId = str(payload.session_id);
  if (sessionId === null || sessionId === '') return '';
  if (hasPending(db, sessionId)) close(db, payload, sessionId);

  const cycle = latestCycle(db, sessionId);
  if (cycle === null || cycle.injected) return '';
  return deliverIndex(db, cycle, 'user-prompt-submit', 'UserPromptSubmit');
}

// Reached once per compaction that PostCompact left pending, because reconciling clears the row
// that brings us here. Every other prompt costs one indexed read.
function close(db: DatabaseSync, payload: Payload, sessionId: string): void {
  const path = resolveTranscript(payload);
  if (path === null) {
    logEvent(db, 'user-prompt-submit', 'warn', 'a cycle is pending but its transcript is gone');
    return;
  }
  for (const r of catchUp(db, parseTranscript(path), sessionId)) {
    const detail = r.summarized ? `${r.verdicts} verdicts persisted` : 'no summary found; verdicts left NULL';
    logEvent(db, 'user-prompt-submit', r.summarized ? 'info' : 'warn', `closed cycle ${r.cycle}: ${detail}`);
  }
}
