import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { archiveBytes, databaseFile, hookStats, storeStats } from '../store/db.js';
import { UNCERTAIN_MAX, UNCERTAIN_MIN } from '../reconcile/render.js';
import { usageWrap } from './args.js';

// The field-test export: one JSON document describing how the loop behaved, holding none of what it
// archived. The archive stores verbatim transcripts, and a transcript routinely contains secrets, so
// this command must be safe to send to the maintainer without reading it first.
//
// The rule is an allowlist rather than a filter. Every value below is an integer, a float, an ISO
// timestamp, a member of a closed enum, or a truncated hash. No query here reads `anchors.key`,
// `anchors.excerpt`, `messages.record`, `messages.role`, `cycles.summary`, or `log.msg`.
//
// Two deliberate departures from the conventions every other command follows:
//   - No output cap. A truncated JSON document does not parse, and this one answers into a file
//     rather than a context window. Its size is bounded by shape instead: one entry per cycle, at
//     most one per anchor type, one per (cmd, type, cycle) triple.
//   - No telemetry row. This command reads the telemetry table, so recording its own visit would
//     change the measurement and make two consecutive runs disagree.
const SCHEMA = 1;

export function report(db: DatabaseSync, argv: string[]): string {
  usageWrap(() => parseArgs({ args: argv, options: {} }));
  return `${JSON.stringify({ schema: SCHEMA, env: env(db), data: data(db) }, null, 2)}\n`;
}

// Everything needed to know whether one tester's numbers are comparable with another's. The project
// hash lives here rather than beside the measurements because it identifies the machine, not the
// behaviour — which also keeps `data` free of anything that varies by where the archive sits.
function env(db: DatabaseSync): Record<string, string> {
  return {
    sebastian: version(),
    node: process.version,
    platform: process.platform,
    project: hash(projectOf(db), 12),
  };
}

function data(db: DatabaseSync): Record<string, unknown> {
  return {
    totals: totals(db),
    hooks: hookStats(db),
    cycles: cycles(db),
    byType: byType(db),
    retrievals: retrievals(db),
  };
}

function totals(db: DatabaseSync): Record<string, number> {
  const stats = storeStats(db);
  return {
    sessions: stats.sessions,
    messages: stats.messages,
    anchors: stats.anchors,
    reconciled: stats.reconciled,
    cycles: stats.cycles,
    reconciledCycles: stats.reconciledCycles,
    dbBytes: archiveBytes(db),
  };
}

// One row per compaction that happened, in the order it happened. `injectedTokens` is null when
// SessionStart never ran for the cycle, and 0 when it ran and the summary had dropped nothing —
// the distinction is the point of the column.
function cycles(db: DatabaseSync): Record<string, unknown>[] {
  const counted =
    'SELECT COUNT(*) FROM anchors a WHERE a.session_id = c.session_id AND a.cycle = c.cycle';
  const rows = db
    .prepare(
      'SELECT c.session_id, c.cycle, c.trigger, c.injected_tokens, ' +
        `(${counted}) AS anchors, ` +
        `(${counted} AND a.verdict IS NOT NULL) AS reconciled, ` +
        `(${counted} AND a.verdict = 'dropped') AS dropped ` +
        'FROM cycles c ORDER BY c.session_id, c.cycle',
    )
    .all();
  return rows.map((r) => ({
    cycle: Number(r.cycle),
    session: hash(String(r.session_id), 8),
    trigger: r.trigger === null ? null : String(r.trigger),
    anchors: Number(r.anchors),
    reconciled: Number(r.reconciled),
    dropped: Number(r.dropped),
    injectedTokens: intOrNull(r.injected_tokens),
  }));
}

// Drop-rate by anchor type, with the two presentation bands the renderer uses. The bands come from
// the renderer's own thresholds so one definition serves the injected digest and this export.
// Alphabetical by type, because a stable order needs no shared priority constant.
function byType(db: DatabaseSync): Record<string, unknown>[] {
  const rows = db
    .prepare(
      "SELECT type, COUNT(*) AS observed, SUM(verdict = 'dropped') AS dropped, " +
        'AVG(score) AS mean_score, ' +
        "SUM(verdict = 'dropped' AND score < ?) AS absent, " +
        "SUM(verdict = 'dropped' AND score >= ? AND score < ?) AS uncertain " +
        'FROM anchors WHERE verdict IS NOT NULL GROUP BY type ORDER BY type',
    )
    .all(UNCERTAIN_MIN, UNCERTAIN_MIN, UNCERTAIN_MAX);
  return rows.map((r) => ({
    type: String(r.type),
    observed: Number(r.observed),
    dropped: Number(r.dropped),
    meanScore: round4(Number(r.mean_score)),
    absent: Number(r.absent),
    uncertain: Number(r.uncertain),
  }));
}

// What the archive was asked for, and whether the request found anything. `cycle` is the cycle
// attributed at command time; see the schema comment for why it is an attribution.
function retrievals(db: DatabaseSync): Record<string, unknown>[] {
  const rows = db
    .prepare(
      'SELECT cmd, anchor_type, cycle, COUNT(*) AS n, SUM(hits > 0) AS with_hits FROM telemetry ' +
        'GROUP BY cmd, anchor_type, cycle ORDER BY cmd, anchor_type, cycle',
    )
    .all();
  return rows.map((r) => ({
    cmd: String(r.cmd),
    type: r.anchor_type === null ? null : String(r.anchor_type),
    cycle: intOrNull(r.cycle),
    count: Number(r.n),
    withHits: Number(r.with_hits),
  }));
}

// The project slug is the archive directory's name, and it carries the tester's home directory and
// repository name — so it is hashed rather than sent.
function projectOf(db: DatabaseSync): string {
  return basename(dirname(databaseFile(db)));
}

function hash(value: string, chars: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, chars);
}

// A stale build makes every number in the export suspect, so the version travels with the data. The
// manifest sits two levels above this module in both layouts — the repository and an installed
// package — and an unreadable one is reported rather than thrown.
function version(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function intOrNull(value: SQLOutputValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
