import type { DatabaseSync } from 'node:sqlite';
import { archiveDelta, logEvent } from '../store/db.js';
import { computeSteering } from '../steer/adapt.js';
import { extractAnchors } from '../transcript/anchors.js';
import { parseTranscript } from '../transcript/parse.js';
import { str } from '../transcript/text.js';
import { resolveTranscript, type Payload } from './runHook.js';

// Two jobs, in this order: archive the transcript delta, then return the steering block that
// Claude Code appends to the summarizer's compact instructions.
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
    return withPrecedence(computeSteering(db), payload);
  }
  const events = parseTranscript(path);
  const counts = archiveDelta(db, events, extractAnchors(events));
  logEvent(
    db,
    'pre-compact',
    'info',
    `archived ${counts.messages} messages and ${counts.anchors} anchors from ${path}`,
  );
  return withPrecedence(computeSteering(db), payload);
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
