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
  //
  // Every id below is a literal, so the set is also the id grammar: t{turn}{typeLetter}{ordinal},
  // over the closed seven-letter alphabet. Ids are the archive's primary key, so a type that
  // claims an occupied letter, or an ordinal that restarts, orphans archived rows.
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
  // Two boundaries, and each one closes its restoration window a different way. b6's window runs
  // through the summary, the caveat, the slash-command envelope, a deferred-tools delta and a
  // service record, and closes only when the human resumes at u14. b15's closes at the assistant
  // record a18, and the file attached after that record must stay out: a window that never closes
  // on the model's own reply collects later attachments and reports them restored, which reads as
  // kept and hides a real drop. b15 also carries a non-restoring attachment that does have a
  // filename, so the attachment-type test is what excludes it, not the absence of a name field.
  it('closes each restoration window at its own resumption, at the human for one boundary and at the assistant reply for the other', () => {
    const boundaries = readBoundaries(parseTranscript(fixture('boundary.jsonl')));
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]).toEqual({
      uuid: 'b6',
      cycle: 0,
      trigger: 'manual',
      preservedUuids: new Set(['u0', 'a1']),
      restoredPaths: new Set(['/repo/src/parser/index.ts', '/repo/src/parser/tokens.ts']),
    });
    expect(boundaries[1]).toEqual({
      uuid: 'b15',
      cycle: 1,
      trigger: 'auto',
      preservedUuids: new Set(['u14']),
      restoredPaths: new Set(['/repo/src/parser/lex.ts']),
    });
  });

  it('survives a truncated final line, which still occupies its turn', () => {
    const events = parseTranscript(fixture('boundary.jsonl'));
    expect(events).toHaveLength(21);
    expect(events[20]?.type).toBe('unknown');
    expect(events[20]?.record).toBeNull();
  });

  // The service records, the attachments, the summary and the assistant reply that resumes after
  // b15 all occupy turns and yield nothing, so the two user anchors keep the turns they had.
  it('service records and the summary yield no anchors, and cycle increments after each boundary', () => {
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
  // the deepest real frame; e8 arrives wrapped in <tool_use_error>, which never reaches the key;
  // e9 is a red run whose last line quotes a platform text, and the one real signature above it
  // must survive that — noise is a property of a line, not of the result that contains it.
  //
  // e7 is a red run of 31 FAILED lines capped at three anchors. Its first failure is printed
  // twice, the way a runner lists a failure inline and again in its summary, so the three keys
  // below are reached only by collapsing the repeat: without that, one failure spends two of the
  // three slots and the index reports one loss as two.
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
  // than stripped of every non-letter, which would leave `whats`. u23 is the same cut against the
  // typographic apostrophe that platforms substitute for the straight one: read as an imperative
  // it would take a user anchor of its own and leave a24 with no question to answer.
  //
  // a18 answers a bare `Why?`, whose every word is a stopword, so its key falls back to the
  // question's own words. An empty key indexes nothing, and two unrelated short questions in one
  // session would then share it and read as one question to reconciliation.
  //
  // Three Bash keys, each pinning one silent half of the command scan. a11's `|` sits inside
  // quotes and is not a segment break: splitting on it drops the file operand behind it, leaving
  // a correct-looking cmd anchor and an unindexed re-read. Its result carries `Exit code 0`,
  // which must stay out of the key, or one command counts as two things. a19 carries a
  // `2>/dev/null` redirection, which holds a slash and passes the flag and digit filters, so it
  // reads as a second file operand unless redirection tokens are excluded outright. a21 joins two
  // commands with `&&`, and only the second is a read — unsplit, the segment opens with `npm` and
  // the read is invisible.
  //
  // a22 is the second producer of the `url` type: WebSearch carries no URL, so its query is the
  // key. u25 closes the file on an unanswered question, which has no later record to flush it —
  // the deferred candidate has to be released when the records run out, or a session that ends
  // mid-question loses its last instruction.
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
      { id: 't21c1', type: 'cmd', key: "npm run build && sed -n '1,20p' /repo/src/steer/adapt.ts", uuid: 'a21', cycle: 0 },
      { id: 't21r1', type: 'read', key: '/repo/src/steer/adapt.ts', uuid: 'a21', cycle: 0 },
      { id: 't22w1', type: 'url', key: 'node sqlite fts5 tokenizer options', uuid: 'a22', cycle: 0 },
      { id: 't24a1', type: 'answer', key: 'busy second session set timeout', uuid: 'a24', cycle: 0 },
      { id: 't25u1', type: 'user', key: 'which anchor types earn a full index instead of the digest', uuid: 'u25', cycle: 0 },
    ]);
  });

  // The key is the quote the index matches on, and the excerpt is what `seb show` displays. u8 is
  // the only multi-sentence message in any fixture: everywhere else the opening sentence and the
  // highest-scoring one coincide, so the sentence scoring is invisible and a key that silently
  // became the excerpt would still look right.
  it('keeps the whole message as the user excerpt while the key is only the decision sentence', () => {
    const anchor = extract('user-cases.jsonl').find((a) => a.uuid === 'u8');
    expect(anchor?.excerpt).toBe(
      'I looked at the panel again. The retry count is fine for now. ' +
        'Never let the reconciler write to the archive table directly.',
    );
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
});
