import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// This repo is public and every fixture is a hand-written imitation of a Claude Code session.
// A real transcript pasted in by accident leaks prompts, absolute paths, credentials, and internal
// hostnames, and no other gate in the repo looks for that. This test is that gate, in CI too.

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

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

// A dotted token is a hostname candidate. Fixtures are full of dotted tokens that are not
// hostnames, so two filters follow: the final label must look like a top-level domain, and it must
// not be a code or data file extension.
const DOTTED_TOKEN = /[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+/g;
const TLD_LIKE = /^[a-z]{2,24}$/;

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
  for (const [token] of line.matchAll(DOTTED_TOKEN)) {
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

describe('fixture safety', () => {
  it('catches a real transcript committed as a fixture: home paths, credentials, base64 blobs, private hostnames', () => {
    const names = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
    // A broken glob would turn this test green while scanning nothing.
    expect(names.length).toBeGreaterThan(0);

    const findings = names.flatMap((name) =>
      scanFixture(readFileSync(join(FIXTURE_DIR, name), 'utf8')).map((f) => `${name}: ${f}`),
    );
    expect(findings).toEqual([]);
  });

  it('flags every banned pattern in a synthetic leak while passing file names, timestamps, long dot-free paths and example.com', () => {
    const sample = [
      '{"cwd":"/Users/realperson/work","host":"ci.buildbox.internal"}',
      '{"text":"read sync.json and retry.ts at 2026-08-30T00:00:00.000Z, see https://example.com/docs"}',
      '{"auth":"Bearer sk-not-a-real-key","pat":"ghp_fake","blob":"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w"}',
      '{"host":"db-prod-3.corp.acme.net","home":"/home/runner/work"}',
      '{"path":"/repo/src/features/reconciliation/pipeline/stages/preserve"}',
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
    ]);
  });
});
