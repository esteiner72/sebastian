import type { DatabaseSync } from 'node:sqlite';
import { isCompactSummary, readBoundaries, type Boundary, type TranscriptEvent } from '../transcript/parse.js';
import { obj, str } from '../transcript/text.js';
import {
  archiveDelta, clearPending, logEvent, pendingCycles, persistVerdicts, recordCycle, recordedCycles,
  stampReconciled,
} from '../store/db.js';
import { extractAnchors } from '../transcript/anchors.js';
import { reconcile } from './reconcile.js';

// The cycle the running compaction closes, read off the transcript rather than off a clock.
//
// Only the newest boundary is considered. If it has no `cycles` row it is this compaction's and the
// hook is simply late; otherwise this compaction's record has not landed yet and its cycle is the
// number of boundaries already present, since cycle indices are boundary positions.
//
export function targetCycle(recorded: Set<number>, events: TranscriptEvent[]): number {
  const boundaries = readBoundaries(events);
  const newest = boundaries.at(-1);
  if (newest !== undefined && !recorded.has(newest.cycle)) return newest.cycle;
  return boundaries.length;
}

export interface CycleInput {
  events: TranscriptEvent[];
  boundary: Boundary;
  sessionId: string;
  trigger: string | null;
}

export interface CycleResult {
  cycle: number;
  anchors: number;
  verdicts: number;
  // False when no summary could be found, which is terminal for this cycle: it can never earn
  // verdicts, so a caller must not queue it for another attempt.
  summarized: boolean;
}

// The one place a cycle is recorded and judged, shared by the hook that observes a compaction and
// by the recovery paths that find one already past.
//
// Archiving precedes reconciliation: verdicts can only be persisted onto anchor rows that exist,
// and the records compaction appends — the boundary, the summary, the restorations — land after
// PreCompact ran.
export function reconcileOneCycle(db: DatabaseSync, input: CycleInput): CycleResult {
  const { events, boundary, sessionId, trigger } = input;
  const summary = readSummary(events, boundary);
  recordCycle(db, {
    sessionId, cycle: boundary.cycle, trigger, summary, compactionMs: boundary.durationMs,
    preTokens: boundary.preTokens, postTokens: boundary.postTokens,
    cumulativeDroppedTokens: boundary.cumulativeDroppedTokens,
  });
  const anchors = extractAnchors(events);
  archiveDelta(db, events, anchors);

  const mine = anchors.filter((a) => a.cycle === boundary.cycle);
  if (summary === null) {
    return { cycle: boundary.cycle, anchors: mine.length, verdicts: 0, summarized: false };
  }
  const verdicts = reconcile(mine, summary, boundary.preservedUuids, boundary.restoredPaths);
  const persisted = persistVerdicts(db, verdicts);
  stampReconciled(db, sessionId, boundary.cycle);
  return { cycle: boundary.cycle, anchors: mine.length, verdicts: persisted, summarized: true };
}

// Reconciles every boundary on disk that has no `cycles` row.
//
// The work list shrinks on every pass: `reconcileOneCycle` always writes a row, including for a
// cycle whose summary can never be found. A list keyed on anchors with null verdicts would never
// terminate, since such a cycle stays unverdicted forever.
//
export function catchUp(db: DatabaseSync, events: TranscriptEvent[], sessionId: string): CycleResult[] {
  const recorded = recordedCycles(db, sessionId);
  return readBoundaries(events)
    .filter((b) => !recorded.has(b.cycle))
    .map((boundary) => {
      const result = reconcileOneCycle(db, { events, boundary, sessionId, trigger: boundary.trigger });
      clearPending(db, sessionId, boundary.cycle);
      return result;
    });
}

// Runs catch-up and logs one line per recovered cycle under the calling hook's name: an earlier
// compaction never closed, and the count is how a reader tells a recovered backlog from a quiet one.
export function logCatchUp(db: DatabaseSync, hook: string, events: TranscriptEvent[], sessionId: string): void {
  for (const r of catchUp(db, events, sessionId)) {
    const detail = r.summarized ? `${r.verdicts} verdicts persisted` : 'no summary found; verdicts left NULL';
    logEvent(db, hook, r.summarized ? 'info' : 'warn', `recovered cycle ${r.cycle}: ${detail}`);
  }
}

// Closes every pending cycle of a session whose transcript is gone. A boundary on disk with no
// summary is recorded as an unreconciled cycle; a pending row with no transcript is the same
// situation with less evidence, so it gets the same row: null summary, null metrics, and no
// `reconciled_at`, because the cycle is recorded, not judged. Its anchors stay reachable through
// `seb search`.
export function abandonPending(db: DatabaseSync, sessionId: string): number[] {
  return pendingCycles(db, sessionId).map((cycle) => {
    recordCycle(db, {
      sessionId, cycle, trigger: null, summary: null, compactionMs: null,
      preTokens: null, postTokens: null, cumulativeDroppedTokens: null,
    });
    clearPending(db, sessionId, cycle);
    return cycle;
  });
}

// The summary a cycle is scored against, taken from the transcript. Compaction appends it beside
// the boundary record: 15,791 characters at the newest live compaction.
//
// The summary belonging to a boundary is the first one in the region that boundary opens, which is
// cycle+1. Taking the newest summary above this cycle instead would hand an earlier boundary a later
// cycle's text.
//
// No summary found leaves every verdict NULL. Matching against nothing rules every anchor dropped at
// score 0, and one such cycle poisons drop-rate permanently.
export function readSummary(events: TranscriptEvent[], boundary: Boundary): string | null {
  return nonBlank(transcriptSummary(events, boundary));
}

function transcriptSummary(events: TranscriptEvent[], boundary: Boundary): string | null {
  const record = events.find((e) => isCompactSummary(e) && e.cycle === boundary.cycle + 1);
  const content = obj(record?.record?.message)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.map((block) => str(obj(block)?.text)).filter((t) => t !== null);
  return parts.length === 0 ? null : parts.join('\n');
}

function nonBlank(text: string | null): string | null {
  return text !== null && text.trim() !== '' ? text : null;
}
