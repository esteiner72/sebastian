import { readFileSync } from 'node:fs';
import { genuineUserText, obj, str } from './text.js';

// One transcript record. The Claude Code JSONL format is undocumented and unstable, so unknown
// shapes are kept: `raw` is the original line verbatim, `record` is whatever parsed out of it.
export interface TranscriptEvent {
  turn: number;
  uuid: string | null;
  sessionId: string | null;
  cycle: number;
  type: string;
  ts: string | null;
  role: string | null;
  raw: string;
  record: Record<string, unknown> | null;
}

export interface Boundary {
  uuid: string;
  cycle: number;
  trigger: string | null;
  preservedUuids: Set<string>;
  restoredPaths: Set<string>;
}

// Tolerant line-by-line parse. A line that fails JSON.parse (crash-torn tail, unknown framing)
// still occupies its turn with record null, so turns stay stable as the file grows. `turn` is the
// 0-based file position over every record, including archive-only types — a pure position index
// cannot drift when record classification changes, which keeps anchor ids stable.
export function parseTranscript(path: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  let cycle = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const event = toEvent(events.length, cycle, line);
    events.push(event);
    if (isBoundary(event)) cycle += 1;
  }
  return events;
}

export function toEvent(turn: number, cycle: number, raw: string): TranscriptEvent {
  const record = parseLine(raw);
  const message = obj(record?.message);
  return {
    turn,
    uuid: str(record?.uuid),
    sessionId: str(record?.sessionId) ?? str(record?.session_id),
    cycle,
    type: str(record?.type) ?? 'unknown',
    ts: str(record?.timestamp),
    role: str(message?.role),
    raw,
    record,
  };
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    return obj(JSON.parse(line));
  } catch {
    return null;
  }
}

export function isBoundary(event: TranscriptEvent): boolean {
  return event.type === 'system' && str(event.record?.subtype) === 'compact_boundary';
}

export function isCompactSummary(event: TranscriptEvent): boolean {
  return event.type === 'user' && event.record?.isCompactSummary === true;
}

// Boundaries carry two exact-truth sets: the messages preserved verbatim in context
// (compactMetadata.preservedMessages.allUuids) and the files the platform restored right after
// the boundary. restoredPaths has two consumers — reconciliation Stage 0b and the eval harness's
// deriveNeeded — so it must stay the complete restored set, never a narrowed one.
export function readBoundaries(events: TranscriptEvent[]): Boundary[] {
  return events.filter(isBoundary).map((event) => ({
    uuid: event.uuid ?? '',
    cycle: event.cycle,
    trigger: str(obj(event.record?.compactMetadata)?.trigger),
    preservedUuids: preservedUuids(event),
    restoredPaths: restoredPaths(events, event.turn),
  }));
}

function preservedUuids(event: TranscriptEvent): Set<string> {
  const preserved = obj(obj(event.record?.compactMetadata)?.preservedMessages);
  const all = preserved?.allUuids;
  if (!Array.isArray(all)) return new Set();
  return new Set(all.filter((u): u is string => typeof u === 'string'));
}

// The restoration window runs from the boundary to the point the conversation resumes: the first
// assistant record or the first genuine typed user message. Measured on a real boundary, the
// window interleaves the summary, meta and slash-command envelope records, context-delta
// attachments, and service records around the file restores — so only resumption can end it.
// Only attachments of type `file` and `compact_file_reference` contribute paths.
function restoredPaths(events: TranscriptEvent[], boundaryTurn: number): Set<string> {
  const paths = new Set<string>();
  for (const event of events.slice(boundaryTurn + 1)) {
    if (event.type === 'assistant' || genuineUserText(event) !== null) break;
    const path = restoredPath(event);
    if (path !== null) paths.add(path);
  }
  return paths;
}

function restoredPath(event: TranscriptEvent): string | null {
  const attachment = obj(event.record?.attachment);
  const kind = str(attachment?.type);
  if (kind !== 'file' && kind !== 'compact_file_reference') return null;
  return str(attachment?.filename) ?? str(attachment?.filePath) ?? str(attachment?.path);
}
