import type { AnchorType } from '../transcript/anchors.js';

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

const TYPES: AnchorType[] = ['error', 'answer', 'edit', 'user', 'cmd', 'read', 'url'];

export function anchorType(value: string | undefined): AnchorType | undefined {
  if (value === undefined) return undefined;
  const type = TYPES.find((t) => t === value);
  if (type === undefined) throw new UsageError(`--type takes one of ${TYPES.join('|')}, got "${value}"`);
  return type;
}
