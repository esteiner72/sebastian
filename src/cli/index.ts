import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { logTelemetry, newestReconciledCycle, type ReconciledCycle } from '../store/db.js';
import { renderForgottenIndex } from '../reconcile/render.js';
import type { Anchor } from '../transcript/anchors.js';
import { usageWrap } from './args.js';
import { anchorLine, capOutput, OUTPUT_TOKENS, spansSessions } from './output.js';

const HINT = '--cycle on `seb timeline`, or `seb search` with a query';

interface Options {
  list: 'dropped' | 'all' | null;
  raw: boolean;
}

interface Entry {
  anchor: Anchor;
  verdict: string;
  score: number;
}

// The index the last compaction earned, on demand. With no flag it is the same tiered render that
// SessionStart injects; `--dropped` and `--all` list every anchor of the cycle instead, including
// the types that are counted but never injected, and `--raw` adds the reconciler's score.
export function indexCommand(db: DatabaseSync, argv: string[]): string {
  const opts = parseIndex(argv);
  const cycle = newestReconciledCycle(db);
  if (cycle === null) {
    logTelemetry(db, { cmd: 'index', hits: 0 });
    return 'No reconciled cycle in this project yet; `seb search` still reaches everything archived.\n';
  }
  const entries = select(cycle, opts);
  logTelemetry(db, { cmd: 'index', sessionId: cycle.sessionId, hits: entries.length });
  return opts.list === null ? renderInjected(cycle) : renderList(cycle, entries, opts);
}

// `--raw` on its own is the dropped list with scores: the tiered render has no slot for a score,
// so asking for scores is asking for the list.
function parseIndex(argv: string[]): Options {
  const { values } = usageWrap(() =>
    parseArgs({
      args: argv,
      options: {
        dropped: { type: 'boolean' },
        all: { type: 'boolean' },
        raw: { type: 'boolean' },
      },
    }),
  );
  const raw = values.raw === true;
  if (values.all === true) return { list: 'all', raw };
  return { list: values.dropped === true || raw ? 'dropped' : null, raw };
}

// The anchors and verdicts of a reconciled cycle arrive as parallel lists in one order.
function select(cycle: ReconciledCycle, opts: Options): Entry[] {
  const entries = cycle.anchors.map((anchor, i) => ({
    anchor,
    verdict: cycle.verdicts[i]?.verdict ?? 'dropped',
    score: cycle.verdicts[i]?.score ?? 0,
  }));
  return opts.list === 'all' ? entries : entries.filter((e) => e.verdict === 'dropped');
}

function renderInjected(cycle: ReconciledCycle): string {
  const text = renderForgottenIndex(cycle.verdicts, cycle.anchors, {
    tier: 'full',
    budget: OUTPUT_TOKENS,
  });
  if (text === '') {
    return `Cycle ${cycle.cycle} of session ${cycle.sessionId} dropped nothing; the summary kept every anchor.\n`;
  }
  return capOutput(text, OUTPUT_TOKENS, HINT);
}

function renderList(cycle: ReconciledCycle, entries: Entry[], opts: Options): string {
  const qualified = spansSessions(entries.map((e) => e.anchor));
  const dropped = cycle.verdicts.filter((v) => v.verdict === 'dropped').length;
  const heading =
    `## Forgotten Index — session ${cycle.sessionId}, cycle ${cycle.cycle} (${opts.list})\n` +
    `${dropped} of ${cycle.verdicts.length} reconciled anchors dropped.\n`;
  const body = entries.map((e) => `${anchorLine(e.anchor, qualified, suffix(e, opts))}\n`).join('');
  return `${heading}${capOutput(body, OUTPUT_TOKENS, HINT)}Retrieve an original with \`seb show <id>\`.\n`;
}

function suffix(e: Entry, opts: Options): string {
  if (opts.raw) return ` [${e.verdict} ${e.score.toFixed(2)}]`;
  return opts.list === 'all' ? ` [${e.verdict}]` : '';
}
