// The error-anchor pipeline. Admission tests the RAW signature (a file and line legitimately
// qualifies there); `key` is the NORMALIZED form (line numbers never appear); `excerpt` keeps the
// raw signature verbatim for display. Tool output is the only valid source — never file contents.

export interface ErrorSignature {
  key: string;
  excerpt: string;
}

// Platform texts, not project errors: 73.5% of is_error=true results in the corpus are Claude
// Code policy events. Enumerated literals, never a pattern on the word "hook" — a project's own
// failing hook is a real error. Extend this list only with texts captured verbatim from a
// transcript.
const PLATFORM_NOISE = [
  "The user doesn't want to proceed with this tool use",
  'This session is isolated in the worktree',
  'File has not been read yet',
  'File has been modified since read',
];

const GATE_PATTERNS = [
  /^Traceback/,
  /^\w+(Error|Exception): /,
  /: error TS\d+/,
  /^FAILED /,
  /^fatal: /,
  /^npm ERR/,
];

const ERROR_LEXICON =
  /error|exception|not found|no such|refused|denied|failed|fatal|cannot|timed out|invalid|missing|unexpected|E[A-Z]{3,}/;

const MAX_SIGNATURES_PER_RESULT = 3;

// One vitest run prints dozens of FAILED lines; the cap keeps a single red run from flooding the
// cycle with anchors.
export function extractErrorSignatures(body: string, isError: boolean): ErrorSignature[] {
  const text = withoutPlatformNoise(stripWrapper(body));
  if (!passesSourceGate(text, isError)) return [];
  const signatures: ErrorSignature[] = [];
  const seen = new Set<string>();
  for (const raw of signatureLines(text)) {
    if (!admits(raw)) continue;
    const key = normalizeSignature(raw);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    signatures.push({ key, excerpt: raw.slice(0, 200) });
    if (signatures.length >= MAX_SIGNATURES_PER_RESULT) break;
  }
  return signatures;
}

function stripWrapper(body: string): string {
  return body.replaceAll('<tool_use_error>', '').replaceAll('</tool_use_error>', '').trim();
}

// Noise is dropped line by line rather than discarding the whole result: a long red run that
// happens to quote one of these texts keeps its own signatures.
function withoutPlatformNoise(text: string): string {
  return text
    .split('\n')
    .filter((line) => !PLATFORM_NOISE.some((noise) => line.includes(noise)))
    .join('\n');
}

function passesSourceGate(text: string, isError: boolean): boolean {
  if (isError || /^Exit code [1-9]/.test(text)) return true;
  return text.split('\n').some((line) => GATE_PATTERNS.some((p) => p.test(line)));
}

// Signature-line selection: a Python traceback yields one signature (final exception line plus
// deepest real frame); otherwise every gate-pattern line is a candidate; otherwise the first
// error-lexicon line; otherwise the first non-empty line after the Exit code header.
function signatureLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.some((l) => l.startsWith('Traceback'))) {
    const sig = tracebackSignature(lines);
    return sig === null ? [] : [sig];
  }
  const gateLines = lines.filter((l) => GATE_PATTERNS.some((p) => p.test(l)));
  if (gateLines.length > 0) return gateLines.map(cleanSignature);
  const lexiconLine = lines.find((l) => ERROR_LEXICON.test(l.toLowerCase()) || /E[A-Z]{3,}/.test(l));
  if (lexiconLine !== undefined) return [cleanSignature(lexiconLine)];
  return exitHeaderFallback(lines);
}

function tracebackSignature(lines: string[]): string | null {
  const finalLine = lines.findLast((l) => /^\w+(Error|Exception)\b/.test(l.trim()));
  if (finalLine === undefined) return null;
  const frames = lines.filter((l) => /^\s*File "/.test(l));
  const realFrame = frames.findLast((l) => !/<(string|stdin|module)>/.test(l));
  const frame = realFrame?.trim().replace(/, in .*$/, '');
  return cleanSignature(frame === undefined ? finalLine.trim() : `${finalLine.trim()} (${frame})`);
}

function exitHeaderFallback(lines: string[]): string[] {
  if (!/^Exit code [1-9]/.test(lines[0] ?? '')) return [];
  const body = lines.slice(1).find((l) => l.trim() !== '');
  return body === undefined ? [] : [cleanSignature(body)];
}

// Strip the platform's trailing cwd advisory, which otherwise splits one identical error into a
// separate key per working directory.
function cleanSignature(line: string): string {
  return line
    .replace(/\s*Note: your current working directory is .*$/, '')
    .trim()
    .slice(0, 300);
}

// Admission, on the raw signature. Degenerate signatures are rejected, not normalized: a new
// failure is not evidence that an old one mattered. The message-fragment arm requires an
// error-lexicon token — "≥ 3 content words" alone admits `All checks passed!`.
function admits(raw: string): boolean {
  const lower = raw.toLowerCase();
  if (/^exit code \d+$/.test(lower) || /^\d+ failed$/.test(lower)) return false;
  if (/^traceback\b[^:]*$/.test(lower)) return false;
  if (/\w+(Error|Exception)\b/.test(raw) || /\bE[A-Z]{4,}\b/.test(raw)) return true;
  if (hasFileAndLine(raw)) return true;
  const contentWords = lower.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return contentWords.length >= 3 && (ERROR_LEXICON.test(lower) || /E[A-Z]{3,}/.test(raw));
}

function hasFileAndLine(raw: string): boolean {
  return /File "[^"]+", line \d+/.test(raw) || /[\w./-]+\.\w+[:(]\d+[,:]?\d*\)?/.test(raw);
}

// Normalization into the grouping key. Path handling runs before digit deletion so basenames
// survive; letter-attached codes (TS2345, E11000) keep the identity that standalone digit runs
// (line numbers, PIDs) do not carry.
export function normalizeSignature(raw: string): string {
  let s = raw;
  s = s.replaceAll(/File "([^"]+)", line \d+/g, (_, p: string) => basename(p));
  s = s.replaceAll(/([\w./~-]*\/[\w.-]+)[:(](\d+)[,:]?(\d*)\)?/g, (_, p: string) => basename(p));
  s = s.replaceAll(/(?:\/tmp|\/var\/folders)\/[\w./-]*/g, 'tmpfile');
  s = s.replaceAll(/(?:~?\/[\w.-]+)+\/([\w.-]+)/g, '$1');
  s = s.replaceAll(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, ' ');
  s = s.replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ');
  s = s.replaceAll(/\b(?=\w*\d)(?=\w*[a-f])[0-9a-f]{6,}\b/gi, ' ');
  s = s.replaceAll(/\b\d+(\.\d+)?\s?(ms|s|m|h|b|kb|mb|gb|kib|mib)\b/gi, ' ');
  s = s.replaceAll(/\b\d+\b/g, ' ');
  s = s.toLowerCase().replaceAll(/[^a-z0-9]+/g, ' ').replaceAll(/\s+/g, ' ').trim();
  return truncateAtToken(s, 160);
}

function basename(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

function truncateAtToken(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, max);
}
