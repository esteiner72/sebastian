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

## Status

Pre-release. You can install it from source today. Release candidates are published to npm under the
`next` tag with provenance, but nothing about the plugin is stable yet.

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
| Something dropped | Up to 400 tokens: counts by type, one entry per type before a second of any, and one pointer |
| No summary reached Sebastian | The same index, labelled unreconciled, because nothing was checked |

Within a type the most recent entry comes first, so the work nearest the compaction is the work
the index names.

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
| `seb search <query>` | Find archived content by keyword, type, cycle, or turn range |
| `seb show <id>` | Print the full original record, with surrounding turns |
| `seb index` | Show the current Forgotten Index |
| `seb timeline` | Show the turn map for a cycle |
| `seb status` | Show cycles, archive size, and steering state |
| `seb report` | Print a JSON summary of how the loop behaved, holding no archived content |

Search covers the whole project rather than one session. Every command caps its output and tells you
how to narrow the result, except `seb report`, which prints one JSON document because a truncated
one does not parse.

## Performance

Measured on a 29 MB, 13,044-record transcript with six compactions.

| Path | Cost |
| --- | --- |
| `seb show` retrieval | 0.01ms |
| `seb search`, 100k anchors | 0.06ms |
| Forgotten Index render, 1600 drops | 2ms |
| Archive one compaction delta | 150ms |

## Privacy

Sebastian makes no network calls. Archived transcripts, the index, and usage telemetry stay on your
machine.

Transcripts routinely contain secrets. Read `SECURITY.md` before you report a problem or contribute
a test fixture.

## License

MIT. See `LICENSE`.
