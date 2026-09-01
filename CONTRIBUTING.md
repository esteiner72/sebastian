# Contributing to Sebastian

Sebastian is a small, pre-release Claude Code plugin with one maintainer. This file lists the rules
a pull request is reviewed against. Read `README.md` first for what the plugin does and
`SECURITY.md` for what a transcript can contain.

## Before you start

You need Node `>=22.16.0 <23` or `>=24`. Sebastian uses the FTS5 extension of `node:sqlite`, which
shipped in 22.16.0 and 24.0.0 and is absent from every 23.x release. There are no native
dependencies.

```bash
git clone https://github.com/esteiner72/sebastian.git
cd sebastian
npm install
npm run build
```

## Run the gates

Four commands must be green before you open a pull request:

```bash
npm run typecheck
npm run lint
npm test
npm run eval
```

CI runs the same four on macOS and Linux across three Node versions, including the 22.16.0 floor. A
local pass predicts a CI pass.

## Code rules

Sebastian optimizes for code that reads straight through.

- Cyclomatic complexity is capped at 12 per function and enforced by eslint. Treat 10 as the
  working limit: above 10, split the function before you add to it.
- Nesting depth is at most 3. Functions are at most 50 lines.
- Use guard clauses and early returns instead of nested conditionals.
- If the control flow needs a comment to follow, split the function instead.

Sebastian carries no legacy. Do not add deprecated exports, compatibility shims, version-gated
branches, or anything kept for old callers. Delete it instead. Breaking changes are fine; bump the
major version. The one exception is external: the Claude Code JSONL transcript format is
undocumented and unstable, so the parser tolerates unknown record shapes by design.

Comments say what a block of code does, in plain language. Comment at block and function level,
state the non-obvious, and never write history: no previous behaviour, no justification for a
change, no dates or tickets. That content belongs in the commit message.

## Tests

The quality gate is the eval harness in `eval/`, scored on recall, precision, recall per thousand
tokens, and latency budgets. Coverage is not measured and is not a goal.

Before you write a test, name the specific failure it catches that the eval harness does not, and
put that answer in the test's name. If you cannot name one, do not write the test. Add a case to
`eval/corpus/cases/` instead.

Only four test shapes are accepted:

- **Format canary.** Real recorded JSONL in, exact expected anchor set out.
- **Round-trip.** Archive a record, retrieve it by UUID, assert it is unchanged.
- **Fail-open.** Force a hook body to throw, assert exit 0 and untouched stdout.
- **Golden.** A rendered string compared against a committed file that was written by hand from
  the specification.

Anything else needs agreement first. Propose the shape in your pull request description before you
write it.

The following are rejected in review:

- Mocking `node:sqlite`, the filesystem, or any module of this package. Use a real temporary
  database and real temporary files.
- Asserting that a function was called, how often, or with which arguments.
- A test whose name restates the function name.
- Asserting a constant equals its literal, a type is that type, or a getter returns what was set.
- Snapshots produced by running the code and accepting the output.
- Any test added to raise a number or satisfy a threshold.
- One test per function as a default habit. Test behaviour at module boundaries.

## Fixtures

Never commit a real transcript. A Claude Code transcript can hold prompts, file contents, command
output, absolute paths, and any credential that appeared in a tool result.

`npm test` scans every fixture and fails on `/Users/`, `/home/`, `sk-`, `ghp_`, `Bearer `, long
base64 runs, and any hostname other than `example.com` and `localhost`. The synthetic corpus uses
one fictional project, a payments library called `ledgerkit` owned by a user named `mara`. New
fixtures and eval cases reuse that world rather than inventing another.

Shape fidelity against real transcripts is checked by the maintainer against a private corpus that
does not live in the repository.

## Commits and pull requests

Commit titles follow `category: thing`, where `thing` is five to eight words. Categories in use are
`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, and `perf`.

```
feat: archive transcript delta on pre-compact
fix: stop steering block dropping user quotes
```

A commit body is four to five sentences of plain language. Say what changed and what it means for
someone using Sebastian. No bullet lists and no file-by-file walkthrough; the diff already says
that.

Pull requests are required on `main`. Open yours with the `## Overview` block the template
provides: the problem in at most two short sentences, then the fix in at most two. Every review
thread must be resolved before merge.

## Documentation

Follow the Google developer documentation style guide: second person, active voice, present tense,
sentence case headings, and spell out an acronym on first use. Documentation lives in `README.md`,
the bundled `SKILL.md`, and this file. Do not add per-module docs or a generated API reference.
