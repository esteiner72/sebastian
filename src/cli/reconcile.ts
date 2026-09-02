import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { strandedSessions } from '../store/db.js';
import { abandonPending, catchUp } from '../reconcile/cycle.js';
import { parseTranscript } from '../transcript/parse.js';
import { sessionTranscript } from '../hooks/runHook.js';
import { plural } from './output.js';
import { usageWrap } from './args.js';

interface Entry {
  line: string;
  recovered: boolean;
}

// Clears the backlog on demand. The loop already heals itself at the next compaction, so this
// exists for the case where waiting for one is not acceptable — a field test with data stranded by
// an earlier build, or a reader who wants the answer now.
//
// A skip is reported, never counted as a recovery. A cycle can be unrecoverable for two reasons
// that look identical in the archive: its transcript is gone, or its summary never reached the
// file. Both are stated, because "0 recovered" without a reason reads as a broken command.
export function reconcileCommand(db: DatabaseSync, argv: string[]): string {
  usageWrap(() => parseArgs({ args: argv, options: {} }));
  // Candidate sessions are a superset: one appears here for its live cycle too. Only a transcript
  // says whether a cycle actually closed, so an empty result is "nothing to do", not "nothing found".
  const entries = strandedSessions(db).flatMap((session) => reconcileSession(db, session));
  if (entries.length === 0) return 'Nothing to reconcile: every closed cycle has a row.\n';
  const recovered = entries.filter((e) => e.recovered).length;
  const skipped = entries.length - recovered;
  const summary =
    `Recovered ${plural(recovered, 'cycle')}` +
    (skipped === 0 ? '.' : `, skipped ${String(skipped)}.`);
  return `${[...entries.map((e) => e.line), summary].join('\n')}\n`;
}

// A skip is stated only when there is a reason to state. A session whose transcript is gone closes
// its pending cycles unreconciled and says so; with no pending row it is indistinguishable from a
// session that simply ended, and its live cycle is not a skip. A transcript that exists but carries
// no summary is still stated, because that cycle can never earn verdicts.
function reconcileSession(db: DatabaseSync, session: string): Entry[] {
  const path = sessionTranscript(session);
  if (path === null) {
    return abandonPending(db, session).map((cycle) => ({
      recovered: false,
      line: `- ${short(session)} cycle ${String(cycle)}: closed unreconciled, transcript no longer on disk`,
    }));
  }
  return catchUp(db, parseTranscript(path), session).map((r) => ({
    recovered: r.summarized,
    line: r.summarized
      ? `- ${short(session)} cycle ${String(r.cycle)}: ${plural(r.verdicts, 'verdict')} over ${plural(r.anchors, 'anchor')}`
      : `- ${short(session)} cycle ${String(r.cycle)}: skipped, no summary in the transcript`,
  }));
}

// The same eight-character prefix `seb search` prints, so an id here can be pasted there.
function short(session: string): string {
  return session.slice(0, 8);
}
