import type { DatabaseSync } from 'node:sqlite';
import { archiveDelta, logEvent, persistVerdicts, recordCycle } from '../store/db.js';
import { reconcile } from '../reconcile/reconcile.js';
import { extractAnchors, type Anchor } from '../transcript/anchors.js';
import { isCompactSummary, parseTranscript, readBoundaries, type Boundary, type TranscriptEvent } from '../transcript/parse.js';
import { obj, str } from '../transcript/text.js';
import { hookTrigger, resolveTranscript, type Payload } from './runHook.js';

// The only writer of `cycles` rows: a row here means compaction actually happened, which is what
// PreCompact cannot know. Reconciles the cycle's anchors against the summary and persists one
// verdict per anchor. Returns the empty string — PostCompact's stdout goes to the user, not the
// model, so this hook injects nothing.
//
// This hook also archives the delta, making `messages` a table with two idempotent writers: the
// records compaction itself appends — the boundary, the summary, the restorations — land after
// PreCompact ran, so on a session's final compaction nothing else would ever archive them, and
// they would not outlive transcript cleanup. Archiving precedes reconciliation so that a cycle
// whose PreCompact was lost still ends complete: verdicts can only be persisted onto anchor rows
// that exist.
export function postCompact(db: DatabaseSync, payload: Payload): string {
  const path = resolveTranscript(payload);
  if (path === null) return warn(db, 'no transcript to reconcile');
  const events = parseTranscript(path);
  const boundary = readBoundaries(events).at(-1);
  if (boundary === undefined) return warn(db, 'no compact boundary in the transcript');

  const summary = readSummary(payload, events, boundary);
  const sessionId = str(payload.session_id) ?? transcriptSession(events) ?? '';
  const trigger = hookTrigger(payload) ?? boundary.trigger;
  recordCycle(db, { sessionId, cycle: boundary.cycle, trigger, summary });
  const anchors = extractAnchors(events);
  archiveDelta(db, events, anchors);
  reconcileCycle(db, anchors, summary, boundary);
  return '';
}

function reconcileCycle(db: DatabaseSync, anchors: Anchor[], summary: string | null, boundary: Boundary): void {
  if (summary === null) {
    logEvent(db, 'post-compact', 'warn', `cycle ${boundary.cycle} recorded with no summary; verdicts left NULL`);
    return;
  }
  const cycleAnchors = anchors.filter((a) => a.cycle === boundary.cycle);
  const verdicts = reconcile(cycleAnchors, summary, boundary.preservedUuids, boundary.restoredPaths);
  const persisted = persistVerdicts(db, verdicts);
  logEvent(db, 'post-compact', 'info', `cycle ${boundary.cycle}: ${persisted} verdicts persisted`);
}

function warn(db: DatabaseSync, msg: string): string {
  logEvent(db, 'post-compact', 'warn', msg);
  return '';
}

// `compact_summary` is the payload field. When it is absent or blank — a hook that did not fire on
// the expected event, an older binary — the summary record the compaction appended after the
// boundary holds the same text. Only records after the last boundary qualify: the newest summary
// anywhere in the file is the previous cycle's whenever this cycle's has not landed yet, and
// reconciling against it would persist verdicts scored on the wrong text. When no summary is found
// the caller leaves every verdict NULL: matching against nothing rules every anchor dropped at
// score 0, and one such cycle poisons drop-rate permanently.
function readSummary(payload: Payload, events: TranscriptEvent[], boundary: Boundary): string | null {
  return nonBlank(str(payload.compact_summary)) ?? nonBlank(transcriptSummary(events, boundary));
}

function transcriptSummary(events: TranscriptEvent[], boundary: Boundary): string | null {
  const record = events.filter((e) => isCompactSummary(e) && e.cycle > boundary.cycle).at(-1);
  const content = obj(record?.record?.message)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.map((block) => str(obj(block)?.text)).filter((t) => t !== null);
  return parts.length === 0 ? null : parts.join('\n');
}

function transcriptSession(events: TranscriptEvent[]): string | null {
  for (const event of events) if (event.sessionId !== null) return event.sessionId;
  return null;
}

function nonBlank(text: string | null): string | null {
  return text !== null && text.trim() !== '' ? text : null;
}
