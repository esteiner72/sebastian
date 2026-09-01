import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { listAnchors, logTelemetry } from '../store/db.js';
import type { Anchor } from '../transcript/anchors.js';
import { integer, usageWrap } from './args.js';
import { capOutput, OUTPUT_TOKENS, plural } from './output.js';

const HINT = '--cycle N';

interface Group {
  sessionId: string;
  cycle: number;
  anchors: Anchor[];
}

// The shape of what was archived, not its content: which turns carry anchors, of which types, so a
// reader can aim `seb show` at a position instead of guessing one. Newest cycle first, because a
// capped map should keep the end of the story rather than its beginning.
export function timeline(db: DatabaseSync, argv: string[]): string {
  const cycle = parseTimeline(argv);
  const anchors = listAnchors(db, cycle);
  logTelemetry(db, { cmd: 'timeline', hits: anchors.length });
  if (anchors.length === 0) {
    const where = cycle === undefined ? 'this project' : `cycle ${cycle}`;
    return `No anchors archived for ${where}.\n`;
  }
  return render(anchors);
}

function parseTimeline(argv: string[]): number | undefined {
  const { values } = usageWrap(() => parseArgs({ args: argv, options: { cycle: { type: 'string' } } }));
  return integer(values.cycle, '--cycle');
}

function render(anchors: Anchor[]): string {
  const groups = groupByCycle(anchors);
  const sessions = new Set(anchors.map((a) => a.sessionId)).size;
  const heading =
    `## Timeline — ${plural(sessions, 'session')}, ${plural(groups.length, 'cycle')}, ` +
    `${plural(anchors.length, 'anchor')}\n`;
  return `${heading}${capOutput(groups.map(groupBlock).join(''), OUTPUT_TOKENS, HINT)}`;
}

// The store orders by cycle, then session, then file position, so a group is a run of adjacent
// rows and grouping never needs a second pass over the whole set.
function groupByCycle(anchors: Anchor[]): Group[] {
  const groups: Group[] = [];
  for (const a of anchors) {
    const last = groups.at(-1);
    if (last !== undefined && last.sessionId === a.sessionId && last.cycle === a.cycle) {
      last.anchors.push(a);
    } else {
      groups.push({ sessionId: a.sessionId, cycle: a.cycle, anchors: [a] });
    }
  }
  return groups;
}

// A group's rows arrive in turn order, so its range is its first and last anchor. Spreading the
// turns into `Math.min` would pass one argument per anchor, which a cycle of a large enough session
// overruns.
function groupBlock(g: Group): string {
  const header =
    `session ${g.sessionId}  cycle ${g.cycle}  ` +
    `turns ${g.anchors[0]?.turn ?? 0}–${g.anchors.at(-1)?.turn ?? 0}  ` +
    `${plural(g.anchors.length, 'anchor')}`;
  return `${[header, ...turnLines(g.anchors)].join('\n')}\n`;
}

function turnLines(anchors: Anchor[]): string[] {
  const byTurn = new Map<number, string[]>();
  for (const a of anchors) {
    const items = byTurn.get(a.turn);
    if (items === undefined) byTurn.set(a.turn, [`${a.id} ${a.type}`]);
    else items.push(`${a.id} ${a.type}`);
  }
  return [...byTurn].map(([turn, items]) => `  turn ${turn}  ${items.join(', ')}`);
}
