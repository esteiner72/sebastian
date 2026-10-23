# Sebastian

[![CI](https://github.com/esteiner72/sebastian/actions/workflows/ci.yml/badge.svg)](https://github.com/esteiner72/sebastian/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sebastian-cc)](https://www.npmjs.com/package/sebastian-cc)
[![License](https://img.shields.io/github/license/esteiner72/sebastian)](LICENSE)
[![Node](https://img.shields.io/badge/node-22.16%2B%20%7C%2024%2B-brightgreen)](#requirements)

Sebastian is a Claude Code plugin that makes compaction recoverable. He is also my dog.

When Claude Code compacts a conversation, a summary replaces the transcript. The raw transcript
survives on disk, but nothing tells the model what the summary dropped, so it never looks. Sebastian
archives the transcript, works out what the summary lost, and hands the model an index of the
missing pieces with the commands that retrieve them. The summary becomes a table of contents over
the archive instead of a replacement for it.

This is a personal project, and is a work in progress, but anyone is free to use or contribute.
It is constantly being tested all-day every-day in my actual work, and I am improving or changing it based
on those results, up until I feel it is in a useful enough place to call it a "v1".

## Status

Pre-release. You can install it from source today. Release candidates are usually published to npm under the
`next` tag with provenance, but nothing about the plugin is stable yet, and I may not publish every RC.

## Requirements

- macOS or Linux. Windows is unsupported.
- Node.js 22.16.0 or later, or 24 or later. Node 23 is unsupported because its `node:sqlite` lacks
  FTS5, the full-text search engine Sebastian's archive depends on.

## Install

Clone the repository and run the setup script. It installs dependencies, builds, registers the
clone as a marketplace, and installs the plugin:

```bash
git clone https://github.com/esteiner72/sebastian.git
cd sebastian
npm run setup
```

Restart Claude Code. Sebastian works from the next compaction onward.

Run `npm run setup` again after every pull, and restart. A plain `npm run build` is not enough:
installing a plugin copies the working tree into Claude Code's plugin cache, and the hooks run that
copy rather than your clone. The setup script refreshes the copy and stops if it does not match what
you just built.

The build is not optional, and skipping it fails silently. `dist/` is not in the repository, and a
hook that cannot find the compiled output exits 0 so that it never blocks a compaction — so a plugin
installed without a build loads, runs, and does nothing. `seb status` reports which hooks have run,
so you can tell a working install from a quiet one.

## How it works

Each compaction cycle runs four steps, and the fourth feeds the first of the next cycle.

```
PreCompact    steer the summarizer, then archive the new part of the transcript
                  |
              Claude Code compacts
                  |
PostCompact   compare the summary against the archive, record what it dropped
                  |
SessionStart  inject the Forgotten Index into the fresh context
                  |
                  +--> the next cycle's steering learns from this cycle's drops
```

1. **Steer.** A `PreCompact` hook writes the compact instructions for the compaction that is about
   to run, telling the summarizer to keep identifiers verbatim.
2. **Archive.** The same hook copies the new part of the transcript into a local SQLite database and
   indexes it for full-text search.
3. **Reconcile.** A `PostCompact` hook receives the summary, checks it against the anchors found in
   the transcript, and records what the summary dropped.
4. **Inject.** A `SessionStart` hook gives the model a Forgotten Index: what the archive holds that
   the summary does not, and the exact command to retrieve each entry.

What each cycle drops steers the next cycle's instructions, so summaries improve as a project
accumulates history.

## What the model receives

Injected context is the resource Sebastian exists to conserve, so it spends as little of it as the
cycle justifies.

| The cycle | What Sebastian injects |
| --- | --- |
| Nothing dropped | Nothing |
| Something dropped | About 400 tokens: counts by type, one entry per type before a second of any, and one pointer |
| No summary reached Sebastian | The same index, labelled unreconciled, because nothing was checked |

Within a type the most recent entry comes first, so the work nearest the compaction is the work
the index names.

**Experiment in progress.** This version withholds the index from a random half of sessions,
which get only a one-line pointer to `seb search`, to measure whether the index earns its tokens.
The arm is recorded in your local archive and nothing leaves your machine. Set
`SEBASTIAN_ARM=index` to always get the index.

On the author's archives, across 414 compactions, the index cost a median of 395 tokens, and nine
in ten cost 431 or fewer. A one-line notice at session start adds about 35. The steering
instructions, about 160 tokens, go to the summarizer with the compaction request rather than into
your context. Other prompts inject nothing. A `seb` command prints at most 2,000 tokens, and only
when the model runs one.

The eval harness in `eval/` is a regression gate over a proxy: synthetic sessions with recorded
summaries, scored on what the index recovers per token. Whether the index helps in live use is a
separate claim, tested by the author in sessions with and without the plugin, and no result is
claimed here yet.

A bundled skill teaches the model to resolve an entry against the summary it already holds and to
retrieve only what is genuinely missing.

## Retrieval

You and the model both reach the archive through the bundled `seb` command. The model runs it from
the plugin directory, so the name does not have to be on your PATH for the loop to work. To use it
yourself, the setup script links it globally where it can; if that did not happen, run
`node dist/index.js <command>` from the clone instead.

| Command | Purpose |
| --- | --- |
| `seb search <query>` | Search everything archived: what you said, what the model said and ran, and what came back. Hits from the calling session come first, with a count for every session |
| `seb show <ref>` | Print a record as readable text, with the tool result that answered it and any surrounding turns. A large record is split into pages |
| `seb index` | Show the current Forgotten Index |
| `seb timeline` | Show the turn map for a cycle |
| `seb status` | Show cycles, archive size, and steering state |
| `seb log` | Show recent hook activity: what ran, when, and what it reported |
| `seb report` | Print a JSON summary of how the loop behaved, holding no archived content |
| `seb reconcile` | Judge any compaction whose bookkeeping did not finish |

Search covers the whole project. When the model runs it, hits from the model's own session print
first and the first line counts the hits in every other session. Every reference a command prints
starts with its session, such as `6fb2c743/2:41`, and a reference without one means the calling
session. Every command caps its output and tells you how to narrow the result, except `seb report`,
which prints one JSON document because a truncated one does not parse.

## Archive layout

Each project has one SQLite database at `~/.claude/sebastian/<project-slug>/sebastian.db`, where
the slug is the working directory with every non-alphanumeric character replaced by a dash. The
hooks write it and the `seb` commands read it. It holds six tables.

| Table | What it holds |
| --- | --- |
| `messages` | Every archived transcript record, keyed by uuid, with its session, cycle, and turn, and its extracted text |
| `anchors` | The identifiers and excerpts extracted from those records, with the verdict and score each received at reconciliation |
| `cycles` | One row per compaction: trigger, summary, token counts, when it was reconciled and injected, and what injection cost, including the one-line note printed when the next compaction starts |
| `pending` | Compactions PostCompact observed but could not close, because Claude Code writes the `compact_boundary` record only after that hook exits |
| `log` | One row per hook invocation carrying its duration, plus whatever each hook body reported |
| `telemetry` | One row per `seb` command run, with what it searched for and how many records it hit |

`seb log` reads the `log` table and its output stays on your machine, because hook messages can
contain absolute transcript paths. `seb report` excludes the log for the same reason. A question that
no command answers can be asked of the database directly with `sqlite3`.

## Performance

Measured on the author's largest archive: about 200,000 messages (prompts, replies, tool calls
and tool results) from 190 sessions over seven weeks, about 114 million tokens of conversation by
Claude Code's own count. Hook times are measured inside the hook. Starting Node adds about 80 ms
to each.

Each figure is given twice where the two differ. Cold means the archive is not in the operating
system's file cache, for example after a restart or when the project has been idle. Warm means it
is, for example right after another hook in the same project. Real use falls between the two.

A typical compaction covers about 450 messages, about 368,000 tokens of context. Hook time
depends on how much the compaction archives and on how long the session's transcript has grown.

| Path | Typical compaction, early in a session | Typical compaction, late in a long session | Very large compaction |
| --- | --- | --- | --- |
| Before compaction: archive and steer | 430–440 ms cold, about 225 ms warm | 520–570 ms cold, 360–400 ms warm | 2.2–2.4 s cold, 1.5–1.7 s warm |
| After compaction: check the summary | 30–40 ms cold, 10–15 ms warm | about 50 ms cold, about 30 ms warm | about 80 ms cold, about 60 ms warm |
| Session start after compaction | under 10 ms | under 10 ms | under 10 ms |
| First prompt after compaction | 70–80 ms | 260–330 ms | 600–660 ms |
| Every other prompt | under 10 ms | under 10 ms | under 10 ms |

Late in a long session means a fifth compaction with a 60 MB transcript. A very large compaction
archives about 5,000 messages at once, which happens when most of a session was never archived in
this project, for example because it ran in another directory or worktree.

| Command | Cold | Warm |
| --- | --- | --- |
| `seb search` | 130–310 ms; up to 600 ms for a word as common as "the" | 80–125 ms; up to 270 ms |
| `seb search` when no message holds every word | under 110 ms | under 90 ms |
| `seb show`, including a 1 MB tool result | under 100 ms | under 100 ms |
| First open by a new version, which builds its search and steering tables once | about 2 s | about 0.4 s |

Command times include starting Node. Before compaction, most of the time goes to reading the
transcript and writing the new messages, so it grows with the compaction rather than with the
archive.

Sebastian injects on your next prompt after a compaction, so it registers a `UserPromptSubmit` hook.
Every prompt then starts a short-lived Node process, about 70 to 90 ms including Node startup, and
you pay it in every project once the plugin is installed. A project with no archive exits before
it opens a database, so Sebastian still creates nothing until your first compaction.

## Privacy

Sebastian makes no network calls. Archived transcripts, the index, and usage telemetry stay on your
machine.

Transcripts routinely contain secrets. Read `SECURITY.md` before you report a problem or contribute
a test fixture.

## License

MIT. See `LICENSE`.
