import type { ArchivedMessage } from '../store/db.js';
import { parseLine } from '../transcript/parse.js';
import { obj, str } from '../transcript/text.js';
import { qualifiedRef } from './output.js';

// A record as a reader wants it: what was said, which tools were called with what, and what came
// back. Top-level fields such as `toolUseResult`, usage and classifier metadata never print; they
// repeat what the content blocks already say. Thinking is neither shown to the user nor committed
// to, so it is skipped, as it is in the message index.
export function recordText(raw: string): string {
  const record = parseLine(raw);
  if (record === null) return `[unparseable record]\n${raw}`;
  const message = obj(record.message);
  const kind = str(record.type) ?? 'unknown';
  if (message === null) return str(record.content) ?? `[${kind} record]`;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return `[${kind} record]`;
  const blocks = content.map((b) => obj(b)).filter((b): b is Record<string, unknown> => b !== null);
  const text = blocks.map(blockText).filter((t) => t !== '').join('\n');
  if (text !== '') return text;
  return blocks.some((b) => str(b.type)?.endsWith('thinking') === true)
    ? '[reasoning only, not shown]'
    : `[${kind} record, no text]`;
}

// The qualified position, role and timestamp, then the body, then a blank line between records.
export function recordBlock(m: ArchivedMessage): string {
  const header = `${qualifiedRef(m.sessionId, `${m.cycle}:${m.turn}`)}  ${m.role ?? '-'}  ${m.ts ?? '-'}`;
  const body = recordText(m.raw);
  return `${header}\n${body === '' ? '' : `${body}\n`}\n`;
}

function blockText(block: Record<string, unknown>): string {
  const type = str(block.type) ?? 'unknown';
  switch (type) {
    case 'text':
      return str(block.text) ?? '';
    case 'tool_use':
      return toolCall(block);
    case 'tool_result':
      return toolResult(block);
    case 'image':
      return '[image]';
    case 'thinking':
    case 'redacted_thinking':
      return '';
    default:
      return `[${type} block]`;
  }
}

// One line per input field. Strings print as they are, newlines included, so a written file or a
// multi-line command reads as it was sent; anything else prints as compact JSON.
function toolCall(block: Record<string, unknown>): string {
  const fields = Object.entries(obj(block.input) ?? {}).map(
    ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
  return [`[tool call: ${str(block.name) ?? 'unknown'}]`, ...fields].join('\n');
}

function toolResult(block: Record<string, unknown>): string {
  const header = block.is_error === true ? '[tool result: error]' : '[tool result]';
  const body = resultBody(block.content);
  return body === '' ? header : `${header}\n${body}`;
}

function resultBody(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => obj(b))
    .map((b) => (str(b?.type) === 'image' ? '[image]' : (str(b?.text) ?? '')))
    .filter((t) => t !== '')
    .join('\n');
}
