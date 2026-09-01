import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// This repo is public and every fixture is a hand-written imitation of a Claude Code session.
// A real transcript pasted in by accident leaks prompts, absolute paths, credentials, and internal
// hostnames, and no other gate in the repo looks for that. This test is that gate, in CI too.

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const CORPUS_DIR = fileURLToPath(new URL('../eval/corpus/', import.meta.url));
const CORPUS_TIERS = ['cases', 'violations'];

const BANNED_LITERALS = ['/Users/', '/home/', 'sk-', 'ghp_', 'Bearer '];

// An encoded blob and a long path share an alphabet, so a run must also look like encoded bytes: a
// digit and both letter cases. `/repo/src/features/reconciliation/pipeline/stages/preserve` is 58
// characters of the base64 class and nothing else. Dropping `/` from the class instead would miss a
// third of 56-character blobs, because one `/` cuts the run below the threshold.
const BASE64_RUN = /[A-Za-z0-9+/]{41,}={0,2}/g;

function hasEncodedRun(line: string): boolean {
  for (const [run] of line.matchAll(BASE64_RUN)) {
    if (/[0-9]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  return false;
}

// A dotted token counts as a hostname candidate only where a hostname can appear: as a complete
// string value, or directly after a URL scheme or a userinfo `@`. An authored transcript embeds
// source code, and property access such as `sub.price` or `Object.is` is a dotted token in every
// other position. No exclusion list can separate the two, because property names are an open set
// while these three positions are closed.
const HOST_LABELS = String.raw`[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+`;
const HOST_POSITIONS = [
  new RegExp(`"(${HOST_LABELS})"`, 'g'),
  new RegExp(`://(${HOST_LABELS})`, 'g'),
  new RegExp(`@(${HOST_LABELS})`, 'g'),
];
const TLD_LIKE = /^[a-z]{2,24}$/;

// Candidates report in the order they appear on the line, not in the order the positions are
// tested, so a line carrying two hostnames reads left to right.
function hostCandidates(line: string): string[] {
  const found: { host: string; at: number }[] = [];
  for (const pattern of HOST_POSITIONS) {
    for (const match of line.matchAll(pattern)) {
      if (match[1] !== undefined) found.push({ host: match[1], at: match.index ?? 0 });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.host);
}

// Final labels that mean "file on disk", not "machine on a network". `test` is here for prose that
// names a file without its extension, such as `panel.test`.
const FILE_EXTENSIONS = new Set([
  'bak', 'c', 'cfg', 'cjs', 'conf', 'cpp', 'css', 'csv', 'diff', 'env', 'gif', 'go', 'gz', 'h',
  'hpp', 'html', 'ico', 'ini', 'java', 'jpeg', 'jpg', 'js', 'json', 'jsonl', 'jsx', 'kt', 'lock',
  'log', 'map', 'md', 'mjs', 'mts', 'patch', 'pdf', 'php', 'png', 'py', 'rb', 'rs', 'scss', 'sh',
  'snap', 'sql', 'svg', 'swift', 'tar', 'test', 'toml', 'ts', 'tsv', 'tsx', 'txt', 'xml', 'yaml',
  'yml', 'zip', 'zsh',
]);

// The spec allows exactly these two. `localhost` carries no dot, so it never reaches the filters.
const isAllowedHost = (host: string) => host === 'example.com' || host.endsWith('.example.com');

function findHostnames(line: string): string[] {
  const hosts: string[] = [];
  for (const token of hostCandidates(line)) {
    const tld = token.split('.').at(-1)?.toLowerCase() ?? '';
    if (!TLD_LIKE.test(tld)) continue;
    if (FILE_EXTENSIONS.has(tld)) continue;
    if (isAllowedHost(token.toLowerCase())) continue;
    hosts.push(token);
  }
  return hosts;
}

// Findings name the pattern but never echo the matched credential or path, because this test runs
// in public CI logs. The hostname is the exception: it is the value a maintainer must judge.
function scanLine(line: string): string[] {
  const literals = BANNED_LITERALS.filter((pattern) => line.includes(pattern));
  return [
    ...literals.map((pattern) => `contains ${JSON.stringify(pattern)}`),
    ...(hasEncodedRun(line) ? ['contains a base64 run over 40 characters'] : []),
    ...findHostnames(line).map((host) => `contains non-allowlisted hostname ${JSON.stringify(host)}`),
  ];
}

function scanFixture(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, index) => scanLine(line).map((detail) => `line ${index + 1}: ${detail}`));
}

// Every authored file in the repo that imitates a session: the unit fixtures and the eval corpus.
// A corpus case carries its summary in `case.json`, so both files of a case are in scope — a real
// path pasted while transcribing a real session lands in either one.
function authoredFiles(): { label: string; path: string }[] {
  const files = readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => ({ label: name, path: join(FIXTURE_DIR, name) }));
  for (const tier of CORPUS_TIERS) {
    const root = join(CORPUS_DIR, tier);
    if (!existsSync(root)) continue;
    for (const id of readdirSync(root).sort()) {
      for (const name of ['transcript.jsonl', 'case.json']) {
        const path = join(root, id, name);
        if (existsSync(path)) files.push({ label: `${tier}/${id}/${name}`, path });
      }
    }
  }
  return files;
}

describe('fixture safety', () => {
  it('catches a real transcript committed as a fixture or an eval case: home paths, credentials, base64 blobs, private hostnames', () => {
    const files = authoredFiles();
    // A broken glob would turn this test green while scanning nothing.
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.label.startsWith('cases/'))).toBe(true);

    const findings = files.flatMap((f) =>
      scanFixture(readFileSync(f.path, 'utf8')).map((detail) => `${f.label}: ${detail}`),
    );
    expect(findings).toEqual([]);
  });

  it('flags every banned pattern in a synthetic leak while passing file names, timestamps, long dot-free paths, example.com and embedded property access', () => {
    const sample = [
      '{"cwd":"/Users/realperson/work","host":"ci.buildbox.internal"}',
      '{"text":"read sync.json and retry.ts at 2026-08-30T00:00:00.000Z, see https://example.com/docs"}',
      '{"auth":"Bearer sk-not-a-real-key","pat":"ghp_fake","blob":"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w"}',
      '{"host":"db-prod-3.corp.acme.net","home":"/home/runner/work"}',
      '{"path":"/repo/src/features/reconciliation/pipeline/stages/preserve"}',
      '{"content":"return round(sub.price * remaining) / sub.period.days;"}',
      '{"content":"if (Object.is(a.id, b.id)) return Date.now();"}',
      '{"text":"see https://build.corp.internal/job/42 for the failure"}',
      '{"notify":"deploy@buildbox.internal"}',
    ].join('\n');

    expect(scanFixture(sample)).toEqual([
      'line 1: contains "/Users/"',
      'line 1: contains non-allowlisted hostname "ci.buildbox.internal"',
      'line 3: contains "sk-"',
      'line 3: contains "ghp_"',
      'line 3: contains "Bearer "',
      'line 3: contains a base64 run over 40 characters',
      'line 4: contains "/home/"',
      'line 4: contains non-allowlisted hostname "db-prod-3.corp.acme.net"',
      'line 8: contains non-allowlisted hostname "build.corp.internal"',
      'line 9: contains non-allowlisted hostname "buildbox.internal"',
    ]);
  });
});
