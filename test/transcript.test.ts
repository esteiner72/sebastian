import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAnchors, type Anchor } from '../src/transcript/anchors.js';
import { parseTranscript, readBoundaries } from '../src/transcript/parse.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const extract = (name: string) => extractAnchors(parseTranscript(fixture(name)));

const brief = (a: Anchor) => ({ id: a.id, type: a.type, key: a.key, uuid: a.uuid, cycle: a.cycle });

// Format canaries: real-shaped JSONL in, exact anchor set out. These catch Claude Code changing
// its transcript format and extraction-rule regressions, which a frozen eval corpus never
// notices because it scores in aggregate.

describe('seven-types fixture', () => {
  // The exact set also pins the two joins that fail silently: the cmd key carries `(exit 1)`,
  // which requires reading a tool_result three records later, and the sed command yields both a
  // cmd and a read anchor, because sessions read files with sed far more than with Read.
  it('yields the exact anchor set across all seven types', () => {
    expect(extract('seven-types.jsonl').map(brief)).toEqual([
      { id: 't1a1', type: 'answer', key: 'after first hang loop retry sync timeout', uuid: 'a1', cycle: 0 },
      { id: 't1r1', type: 'read', key: '/repo/src/sync/retry.ts', uuid: 'a1', cycle: 0 },
      { id: 't3d1', type: 'edit', key: '/repo/src/sync/retry.ts', uuid: 'a3', cycle: 0 },
      { id: 't3c1', type: 'cmd', key: 'npm test (exit 1)', uuid: 'a3', cycle: 0 },
      { id: 't4e1', type: 'error', key: 'typeerror cannot read properties of undefined reading reset', uuid: 'u4', cycle: 0 },
      { id: 't5c1', type: 'cmd', key: "sed -n '1,40p' /repo/src/sync/retry.ts", uuid: 'a5', cycle: 0 },
      { id: 't5r1', type: 'read', key: '/repo/src/sync/retry.ts', uuid: 'a5', cycle: 0 },
      { id: 't5w1', type: 'url', key: 'https://example.com/docs/backoff', uuid: 'a5', cycle: 0 },
      { id: 't7u1', type: 'user', key: 'Keep the exponential backoff, and never retry more than three times.', uuid: 'u7', cycle: 0 },
    ]);
  });

  it('the answer anchor carries the answering prose, not the question it keys on', () => {
    const anchors = extract('seven-types.jsonl');
    expect(anchors.find((a) => a.type === 'answer')?.excerpt).toMatch(/^The retry loop hangs/);
  });

  it('the error excerpt keeps the raw signature verbatim while the key is normalized', () => {
    const error = extract('seven-types.jsonl').find((a) => a.type === 'error');
    expect(error?.excerpt).toBe("TypeError: Cannot read properties of undefined (reading 'reset')");
  });
});

describe('boundary fixture', () => {
  it('reads restoredPaths through the interleaved post-boundary machine records, stopping at the resuming prompt', () => {
    const boundaries = readBoundaries(parseTranscript(fixture('boundary.jsonl')));
    expect(boundaries).toHaveLength(1);
    const b = boundaries[0];
    expect(b?.uuid).toBe('b6');
    expect(b?.trigger).toBe('manual');
    expect(b?.preservedUuids).toEqual(new Set(['u0', 'a1']));
    expect(b?.restoredPaths).toEqual(
      new Set(['/repo/src/parser/index.ts', '/repo/src/parser/tokens.ts']),
    );
  });

  it('survives a truncated final line, which still occupies its turn', () => {
    const events = parseTranscript(fixture('boundary.jsonl'));
    expect(events).toHaveLength(16);
    expect(events[15]?.type).toBe('unknown');
    expect(events[15]?.record).toBeNull();
  });

  it('service records and the summary yield no anchors, and cycle increments after the boundary', () => {
    expect(extract('boundary.jsonl').map(brief)).toEqual([
      { id: 't0u1', type: 'user', key: 'Start the refactor of the parser module now.', uuid: 'u0', cycle: 0 },
      { id: 't14u1', type: 'user', key: 'Continue with the tokenizer changes.', uuid: 'u14', cycle: 1 },
    ]);
  });
});

describe('error-cases fixture', () => {
  // Each record is one admission decision, and the exact set is the whole table.
  //
  // Rejected, so absent: a bare `Exit code 1` (e0), a bare traceback header (e1), the
  // worktree-isolation policy text (e2), and `All checks passed!` under a non-zero exit (e3) —
  // three content words carrying no error-lexicon token.
  //
  // Admitted, and what each pins: e4 enters on content alone, with no is_error flag and no exit
  // header, and keeps the letter-attached `ts2345` while losing the standalone `(14,7)`; e5 and
  // e6 are one KeyError at two lines under two pseudo-frames, collapsing to a single key through
  // the deepest real frame; e7 is a 30-line red run capped at three anchors; e8 arrives wrapped
  // in <tool_use_error>, which never reaches the key; e9 is a red run whose third line quotes a
  // platform text, and the two real signatures above it must survive that — noise is a property
  // of a line, not of the result that contains it.
  it('admits and rejects the measured signature classes exactly, and keeps a red run that quotes a platform text', () => {
    expect(extract('error-cases.jsonl').map(brief)).toEqual([
      { id: 't4e1', type: 'error', key: 'render ts error ts2345 argument of type string is not assignable to parameter of type number', uuid: 'e4', cycle: 0 },
      { id: 't5e1', type: 'error', key: 'keyerror payload dispatch py', uuid: 'e5', cycle: 0 },
      { id: 't6e1', type: 'error', key: 'keyerror payload dispatch py', uuid: 'e6', cycle: 0 },
      { id: 't7e1', type: 'error', key: 'failed test case01 test ts renders panel', uuid: 'e7', cycle: 0 },
      { id: 't7e2', type: 'error', key: 'failed test case02 test ts renders panel', uuid: 'e7', cycle: 0 },
      { id: 't7e3', type: 'error', key: 'failed test case03 test ts renders panel', uuid: 'e7', cycle: 0 },
      { id: 't8e1', type: 'error', key: 'enoent no such file or directory open panel json', uuid: 'e8', cycle: 0 },
      { id: 't9e1', type: 'error', key: 'failed test panel test ts renders panel', uuid: 'e9', cycle: 0 },
    ]);
  });
});

describe('user-cases fixture', () => {
  // Each record is one selection decision, and the exact set is the whole table.
  //
  // Excluded: u0 carries a tool_result, u1 is a teammate wrapper, u2 is a two-token ack, u6 is
  // isMeta, u7 is a slash command. a4 replies with tool calls only, so u3's question gets no
  // answer anchor and flushes as a user anchor instead.
  //
  // The interrogative split is the pair u9/u13, and both halves fail silently. u9 opens with
  // `do` and carries no `?`, so it is an imperative and keeps its verbatim quote — read as a
  // question it would trade that quote for a bag-of-words key and point `seb show` at a10's
  // acknowledgement. u13 opens with `can` and also carries no `?`, and is still a question, so
  // its anchor lands on the answering prose at a14 and never on u13 as well. u15 opens `what's`
  // and carries no `?`, so it reaches the list only if the token is cut at the apostrophe rather
  // than stripped of every non-letter, which would leave `whats`. a19's command carries a
  // `2>/dev/null` redirection, which contains a slash and passes the flag and digit filters, so it
  // reads as a second file operand unless redirection tokens are excluded outright.
  it("decides question or imperative from the opening token: bare `can` is a question, bare `do` is not, and `what's` matches only after the apostrophe cut", () => {
    expect(extract('user-cases.jsonl').map(brief)).toEqual([
      { id: 't3u1', type: 'user', key: 'Which config file controls the retry limit for the sync panel?', uuid: 'u3', cycle: 0 },
      { id: 't4r1', type: 'read', key: '/repo/config/sync.json', uuid: 'a4', cycle: 0 },
      { id: 't5u1', type: 'user', key: 'Never mind, I found it myself in the settings file.', uuid: 'u5', cycle: 0 },
      { id: 't8u1', type: 'user', key: 'Never let the reconciler write to the archive table directly.', uuid: 'u8', cycle: 0 },
      { id: 't9u1', type: 'user', key: 'Do not ever commit directly to the main branch.', uuid: 'u9', cycle: 0 },
      { id: 't11c1', type: 'cmd', key: 'rg -n "timeout|retry" /repo/src/sync/retry.ts', uuid: 'a11', cycle: 0 },
      { id: 't11r1', type: 'read', key: '/repo/src/sync/retry.ts', uuid: 'a11', cycle: 0 },
      { id: 't14a1', type: 'answer', key: 'add cap client retry', uuid: 'a14', cycle: 0 },
      { id: 't16a1', type: 'answer', key: 'archive cap writer', uuid: 'a16', cycle: 0 },
      { id: 't18a1', type: 'answer', key: 'why', uuid: 'a18', cycle: 0 },
      { id: 't19c1', type: 'cmd', key: 'cat /repo/notes.txt 2>/dev/null', uuid: 'a19', cycle: 0 },
      { id: 't19r1', type: 'read', key: '/repo/notes.txt', uuid: 'a19', cycle: 0 },
    ]);
  });

  // Every interrogative is also a stopword, so u17 has no content tokens at all. An empty key
  // indexes nothing in the anchor index, and two unrelated short questions in one session would
  // then carry the same key and read as one question to reconciliation.
  it('a bare `Why?` keys its answer on the question words, never on an empty key', () => {
    const anchor = extract('user-cases.jsonl').find((a) => a.uuid === 'a18');
    expect(anchor?.key).toBe('why');
  });

  // Both halves of the Bash join fail quietly. The `|` inside the rg pattern is a shell operator
  // everywhere except inside quotes, and splitting on it drops the file operand that follows —
  // the cmd anchor still looks correct while the re-read goes unindexed. The `Exit code 0` header
  // is the other half: a zero exit in the key would count one command as two things.
  it('reads the file operand behind a quoted alternation, and leaves a zero exit out of the cmd key', () => {
    const anchors = extract('user-cases.jsonl').filter((a) => a.uuid === 'a11');
    expect(anchors.map((a) => `${a.type} ${a.key}`)).toEqual([
      'cmd rg -n "timeout|retry" /repo/src/sync/retry.ts',
      'read /repo/src/sync/retry.ts',
    ]);
  });

  // The key is the quote the index matches on. Every other fixture message is a single sentence,
  // where the opening sentence and the highest-scoring one coincide and the sentence scoring is
  // unobservable — so this is the only place a wrong quote cut shows up.
  it('a three-sentence message keys on the mid-message decision, not on its opening', () => {
    const anchor = extract('user-cases.jsonl').find((a) => a.uuid === 'u8');
    expect(anchor?.key).toBe('Never let the reconciler write to the archive table directly.');
    expect(anchor?.excerpt).toMatch(/^I looked at the panel again\./);
  });
});

describe('anchor identity', () => {
  // Ids are the archive's primary key, so rows written in an earlier cycle must still resolve
  // after the transcript grows. The eval harness extracts each session once and can never see a
  // renumbering.
  it('appending later records leaves every earlier anchor byte-identical', () => {
    const base = readFileSync(fixture('seven-types.jsonl'), 'utf8').trimEnd();
    const delta = readFileSync(fixture('append-delta.jsonl'), 'utf8').trimEnd();
    const grown = join(mkdtempSync(join(tmpdir(), 'sebastian-append-')), 'grown.jsonl');
    writeFileSync(grown, `${base}\n${delta}\n`);
    const before = extract('seven-types.jsonl');
    const after = extractAnchors(parseTranscript(grown));
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map(brief)).toEqual([
      { id: 't9u1', type: 'user', key: 'Also update the changelog before you commit.', uuid: 'u9', cycle: 0 },
      { id: 't10d1', type: 'edit', key: '/repo/CHANGELOG.md', uuid: 'a10', cycle: 0 },
    ]);
  });

  it('ids match t{turn}{typeLetter}{ordinal}, so a new type must claim an unused letter', () => {
    for (const anchor of extract('seven-types.jsonl')) {
      expect(anchor.id).toMatch(/^t\d+[eaducrw]\d+$/);
    }
  });
});
