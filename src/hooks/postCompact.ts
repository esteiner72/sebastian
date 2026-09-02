import type { DatabaseSync } from 'node:sqlite';
import { logEvent, markPending, recordedCycles } from '../store/db.js';
import { targetCycle } from '../reconcile/cycle.js';
import { parseTranscript, type TranscriptEvent } from '../transcript/parse.js';
import { str } from '../transcript/text.js';
import { resolveTranscript, type Payload } from './runHook.js';

// Records that this session just compacted, and nothing else. Returns the empty string:
// PostCompact's stdout goes to the user, not the model.
//
// Claude Code appends the `compact_boundary` record only after this hook's process exits, measured
// at 5 to 8 ms past completion across four compactions and independent of how long the hook ran.
// The record the reconciler needs therefore cannot be read from here at all. The cycle is marked
// pending, and whichever hook next runs with the record on disk closes it — UserPromptSubmit on the
// user's next message, or PreCompact at the next compaction.
export function postCompact(db: DatabaseSync, payload: Payload): string {
  const path = resolveTranscript(payload);
  if (path === null) return warn(db, 'no transcript to reconcile');

  const events = parseTranscript(path);
  const sessionId = str(payload.session_id) ?? transcriptSession(events) ?? '';
  if (sessionId === '') return warn(db, 'no session id; cannot mark the cycle pending');

  const cycle = targetCycle(recordedCycles(db, sessionId), events);
  markPending(db, sessionId, cycle);
  logEvent(db, 'post-compact', 'info', `cycle ${cycle} left pending; its boundary is not on disk yet`);
  return '';
}

function warn(db: DatabaseSync, msg: string): string {
  logEvent(db, 'post-compact', 'warn', msg);
  return '';
}

function transcriptSession(events: TranscriptEvent[]): string | null {
  for (const event of events) if (event.sessionId !== null) return event.sessionId;
  return null;
}
