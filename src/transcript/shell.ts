// Whether a Bash command runs nothing but Sebastian's own retrieval commands: one or more of
// `seb search|show|index|timeline`, or the plugin's `dist/index.js` with the same subcommands, each
// optionally piped through head, tail, rg or cut, with `cd` steps and `2>&1` allowed. Only then are
// the command and its output pure noise for the next search. A call that also does real work, such
// as an `rg` over the source or a `cat` of a file, stays searchable whole. Anything this reading
// cannot be sure of, such as command substitution or an unclosed quote, counts as real work.
const SEB_STAGE =
  /^(?:seb|node\s+["']?[^\s"']*dist\/index\.js["']?)\s+(?:search|show|index|timeline)(?:\s|$)/;
const FILTER_STAGE = /^(?:head|tail|rg|cut)(?:\s|$)/;
const CD_STAGE = /^cd(?:\s|$)/;

export function isSebOnly(command: string): boolean {
  const lists = pipelines(command);
  if (lists === null) return false;
  let seb = false;
  for (const stages of lists) {
    if (stages.length === 1 && CD_STAGE.test(stages[0] ?? '')) continue;
    const [first = '', ...rest] = stages;
    if (!SEB_STAGE.test(first) || !rest.every((s) => FILTER_STAGE.test(s))) return false;
    seb = true;
  }
  return seb;
}

// Splits on the list operators `&&`, `||`, `;` and newlines, then each list item on `|`, outside
// quotes. `2>&1` is dropped from each stage. Empty items, as left by a trailing `;`, are skipped.
function pipelines(command: string): string[][] | null {
  if (/\$\(|`/.test(command)) return null;
  const list = pieces(command);
  if (list === null) return null;
  const items: string[][] = [];
  let stages: string[] = [];
  for (const piece of list) {
    const text = piece.text.replaceAll(/(?:^|\s)2>&1(?=\s|$)/g, ' ').trim();
    if (text !== '') stages.push(text);
    if (piece.ends === 'pipe') continue;
    if (stages.length > 0) items.push(stages);
    stages = [];
  }
  return items;
}

interface Piece {
  text: string;
  ends: 'pipe' | 'list';
}

// The command cut at every operator outside quotes, each piece marked with the operator that ends
// it. An unclosed quote returns null.
function pieces(command: string): Piece[] | null {
  const out: Piece[] = [];
  let text = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] ?? '';
    const width = quote === null ? operatorWidth(command, i) : 0;
    if (width === 0) {
      quote = nextQuote(quote, c);
      text += c;
      continue;
    }
    out.push({ text, ends: c === '|' && width === 1 ? 'pipe' : 'list' });
    text = '';
    i += width - 1;
  }
  if (quote !== null) return null;
  out.push({ text, ends: 'list' });
  return out;
}

function nextQuote(quote: string | null, c: string): string | null {
  if (quote !== null) return c === quote ? null : quote;
  return c === '"' || c === "'" ? c : null;
}

// The width of the operator at `i`, or 0 when there is none. A lone `&` stays part of the stage, so
// a backgrounded command is never read as seb.
function operatorWidth(command: string, i: number): number {
  const two = command.slice(i, i + 2);
  if (two === '&&' || two === '||') return 2;
  const c = command[i];
  return c === ';' || c === '\n' || c === '|' ? 1 : 0;
}
