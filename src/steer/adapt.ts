import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { AnchorType } from '../transcript/anchors.js';

// Printed on PreCompact stdout, which Claude Code appends to the summarizer's compact instructions.
// The summarizer attributes that stdout to the user, so every line reads as a directive about the
// summary ("keep error signatures verbatim") and never as a request ("please include …"), which
// would re-enter the summary as something the user asked for.
const BASE = [
  '## Compact Instructions',
  '- Preserve verbatim: file paths edited, error signatures, commands run, user decisions.',
  '- Prefer dropping prose over dropping identifiers; write "[archived: turn N]" where you drop detail.',
  '- A Forgotten Index of dropped content will be injected; do not re-summarize archived material.',
];

// A type earns an adaptive line only above this drop-rate, and only once enough of its anchors
// carry a verdict for the rate to mean anything. Unreconciled anchors are outside both counts.
const DROP_RATE_MIN = 0.5;
const OBSERVED_MIN = 5;
const MAX_LINES = 15;

// Every type earns adaptive lines except `cmd`: a command-line key essentially never appears in a
// summary, so its drop-rate pins at 1.0 and the line would be a constant — consistent with cmd's
// weak-loss-signal status everywhere else. The list is in injection-priority order, reused as the
// tie-break on equal drop-rates so the block is a function of the database alone.
type SteeredType = Exclude<AnchorType, 'cmd'>;
const STEERED: SteeredType[] = ['error', 'answer', 'edit', 'user', 'read', 'url'];

const PHRASES: Record<SteeredType, { noun: string; directive: string }> = {
  error: { noun: 'error signatures', directive: 'keep error signatures verbatim' },
  answer: { noun: 'explanations', directive: 'keep the explanation, not only the question' },
  edit: { noun: 'file paths edited', directive: 'keep every edited file path' },
  user: { noun: 'user decisions', directive: "keep user decisions in the user's words" },
  read: { noun: 'file paths read', directive: 'keep every file path read' },
  url: { noun: 'URLs', directive: 'keep each URL in full' },
};

interface TypeRate {
  type: SteeredType;
  dropped: number;
  total: number;
  rate: number;
}

// Templates only, no model call: the same database state always prints the same block. A database
// with no verdicts yet prints the base lines alone.
export function computeSteering(db: DatabaseSync): string {
  const retrievals = countRetrievals(db);
  const adaptive = earnedRates(db).map((r) => adaptiveLine(r, retrievals.get(r.type) ?? 0));
  return `${[...BASE, ...adaptive].slice(0, MAX_LINES).join('\n')}\n`;
}

// Drop-rate is the primary signal and is dense: every anchor of every type takes a verdict every
// cycle, so signal exists from cycle two. Rows of an unrecognized type are ignored rather than
// phrased, because the phrase table is the vocabulary.
function earnedRates(db: DatabaseSync): TypeRate[] {
  const rows = db
    .prepare(
      "SELECT type, COUNT(*) AS total, SUM(verdict = 'dropped') AS dropped " +
        'FROM anchors WHERE verdict IS NOT NULL GROUP BY type',
    )
    .all();
  return rows
    .map(toRate)
    .filter((r) => STEERED.includes(r.type) && r.total >= OBSERVED_MIN && r.rate > DROP_RATE_MIN)
    .sort((a, b) => b.rate - a.rate || STEERED.indexOf(a.type) - STEERED.indexOf(b.type));
}

function toRate(row: Record<string, SQLOutputValue>): TypeRate {
  const total = Number(row.total);
  const dropped = Number(row.dropped);
  return { type: String(row.type) as SteeredType, dropped, total, rate: dropped / total };
}

// Retrieval-rate is a multiplier, never a source: it escalates a line that drop-rate already
// earned. Only `seb search` and `seb show` rows count — every CLI command logs telemetry, and an
// index listing is not a retrieval. A type is counted once per command that reached it, and a
// command that returned nothing retrieved nothing.
function countRetrievals(db: DatabaseSync): Map<string, number> {
  const rows = db
    .prepare(
      'SELECT anchor_type AS type, COUNT(*) AS n FROM telemetry ' +
        "WHERE anchor_type IS NOT NULL AND hits > 0 AND cmd IN ('search', 'show') " +
        'GROUP BY anchor_type',
    )
    .all();
  return new Map(rows.map((r) => [String(r.type), Number(r.n)]));
}

function adaptiveLine(r: TypeRate, retrievals: number): string {
  const { noun, directive } = PHRASES[r.type];
  const line = `- This project's summaries dropped ${r.dropped} of ${r.total} ${noun}; ${directive}.`;
  if (retrievals === 0) return line;
  return `${line} Retrieved ${retrievals}× after being dropped.`;
}
