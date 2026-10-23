import type { DatabaseSync } from 'node:sqlite';
import { archiveDelta, logEvent } from '../store/db.js';
import { logCatchUp } from '../reconcile/cycle.js';
import { armFor } from '../reconcile/arm.js';
import { computeSteering } from '../steer/adapt.js';
import { extractAnchors, type Anchor } from '../transcript/anchors.js';
import {
  parseTranscript, readBoundaries, transcriptSession, type TranscriptEvent,
} from '../transcript/parse.js';
import { str } from '../transcript/text.js';
import { resolveTranscript, type Payload } from './runHook.js';

// Three jobs, in this order: archive the transcript delta, reconcile any cycle a previous run left
// stranded, then return the steering block that Claude Code appends to the summarizer's compact
// instructions.
//
// Catch-up lives here because this hook already parses and archives the transcript, so recovery
// reuses those records and anchors and adds no extra I/O. It also runs before steering is computed,
// so a recovered cycle's verdicts reach the drop-rates this compaction is about to be steered by.
//
// No cycle row is written here. PreCompact fires before compaction is decided — a session with too
// few messages to compact still runs this hook — so cycle bookkeeping belongs to PostCompact, or
// every refused compaction shifts the cycle numbers.
//
// Steering is returned even when there is nothing to archive: it is computed from verdicts that
// earlier cycles left in the database, and losing the steering channel is the more expensive
// failure of the two.
export function preCompact(db: DatabaseSync, payload: Payload): string {
  const path = resolveTranscript(payload);
  if (path === null) {
    logEvent(db, 'pre-compact', 'warn', 'no transcript to archive; steering only');
    return withPrecedence(computeSteering(db, null, armFor(str(payload.session_id) ?? '')), payload);
  }
  const events = parseTranscript(path);
  const anchors = extractAnchors(events);
  const counts = archiveDelta(db, events, anchors);
  const sessionId = str(payload.session_id) ?? transcriptSession(events);
  recover(db, events, sessionId, anchors);
  logEvent(
    db,
    'pre-compact',
    'info',
    `archived ${counts.messages} messages and ${counts.anchors} anchors from ${path}`,
  );
  // The boundaries already on disk number the cycle this compaction is about to create.
  return withPrecedence(computeSteering(db, readBoundaries(events).length, armFor(sessionId ?? '')), payload);
}

function recover(
  db: DatabaseSync, events: TranscriptEvent[], sessionId: string | null, anchors: Anchor[],
): void {
  if (sessionId === null || sessionId === '') return;
  logCatchUp(db, 'pre-compact', events, sessionId, anchors);
}

// The argument to `/compact <text>` arrives as custom_instructions, and steering must never
// contradict an explicit user instruction — so a non-empty value earns one closing line ceding
// precedence. Phrased as a summarization directive like every other line, since the summarizer
// attributes this stdout to the user.
function withPrecedence(steering: string, payload: Payload): string {
  const custom = str(payload.custom_instructions);
  if (custom === null || custom.trim() === '') return steering;
  return `${steering}- The user's own compact instructions take precedence over the lines above wherever they conflict.\n`;
}
