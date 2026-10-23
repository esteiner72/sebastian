import { ANCHOR_TYPES, type AnchorType } from '../transcript/anchors.js';

// A condition the caller can fix: an unknown flag, an unparsable id, an anchor that is not in the
// archive. The CLI exits 1 and prints one line on stderr for these. Fail-open is a hook contract
// and does not reach here — an exit 0 with empty output would read as "nothing archived" and teach
// the model to stop looking.
export class UsageError extends Error {}

// `parseArgs` throws a plain TypeError on an unknown or malformed flag, and its message is already
// the right thing to show, so it is re-thrown as a usage error rather than crashing the process.
export function usageWrap<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

export function integer(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value.trim())) throw new UsageError(`${flag} takes a whole number, got "${value}"`);
  return Number(value.trim());
}

// `--turn A:B` is an inclusive range over file positions. Both ends are required, because a
// half-open range written `41:` would silently read as "turn 41 to turn 0" and return nothing.
export function turnRange(value: string | undefined): { from: number; to: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+):(\d+)$/.exec(value.trim());
  if (match === null) throw new UsageError(`--turn takes A:B, got "${value}"`);
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (to < from) throw new UsageError(`--turn A:B needs A <= B, got "${value}"`);
  return { from, to };
}

export interface TypeFlag {
  type: AnchorType | undefined;
  role: string | undefined;
  note: string | null;
}

// Models asking for their own earlier reply reach for `--type assistant`. It matches every record
// the assistant wrote, which is a filter on who wrote it rather than an anchor type, and the note
// says so.
export function typeFlag(value: string | undefined): TypeFlag {
  if (value === undefined) return { type: undefined, role: undefined, note: null };
  if (value === 'assistant') {
    return { type: undefined, role: 'assistant', note: '--type assistant matches every record the assistant wrote.' };
  }
  const type = ANCHOR_TYPES.find((t) => t === value);
  if (type === undefined) {
    throw new UsageError(`--type takes one of ${ANCHOR_TYPES.join('|')} or assistant, got "${value}"`);
  }
  return { type, role: undefined, note: null };
}

export interface CycleFlag {
  cycle: number | undefined;
  session: string | undefined;   // a session prefix, unresolved
  note: string | null;
}

const SESSION_CYCLE = /^([^/\s]+)\/(\d+)$/;

// Models pass a session to `--cycle` when they mean "that session's records". Digits are a cycle
// number; `prefix/N` is a session and a cycle, the form references print; anything else is a
// session prefix. The note states the reading so the model learns the real flags.
export function cycleFlag(value: string | undefined): CycleFlag {
  if (value === undefined) return { cycle: undefined, session: undefined, note: null };
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return { cycle: Number(trimmed), session: undefined, note: null };
  const pair = SESSION_CYCLE.exec(trimmed);
  if (pair !== null) {
    const [, session, cycle] = pair;
    return {
      cycle: Number(cycle),
      session,
      note: `--cycle ${trimmed} is read as --session ${session} --cycle ${cycle}.`,
    };
  }
  return { cycle: undefined, session: trimmed, note: `--cycle ${trimmed} is read as --session ${trimmed}.` };
}
