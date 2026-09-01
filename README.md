# Sebastian

Sebastian is a Claude Code plugin that makes compaction recoverable. He is also my dog.

When Claude Code compacts a conversation, a summary replaces the transcript. The raw transcript
survives on disk, but nothing tells the model what the summary dropped, so it never looks. Sebastian
archives the transcript, works out what the summary lost, and hands the model an index of the
missing pieces with the commands that retrieve them. The summary becomes a table of contents over
the archive instead of a replacement for it.

## Status

Pre-release. You can install it from source today, but the package is not published to npm and
nothing about it is stable yet.

## Requirements

- macOS or Linux. Windows is unsupported.
- Node.js 22.16.0 or later, or 24 or later. Node 23 is unsupported because its `node:sqlite` lacks
  FTS5, the full-text search engine Sebastian's archive depends on.

## Install

Clone the repository and build it. The plugin runs the compiled output in `dist/`, so the build is
not optional:

```bash
git clone https://github.com/esteiner72/sebastian.git
cd sebastian
npm install
npm run build
```

Register the repository as a marketplace and install the plugin from it:

```bash
claude plugin marketplace add ./
claude plugin install sebastian@sebastian
```

Restart Claude Code. Sebastian works from the next compaction onward. After you pull a new version,
run `npm run build` again and restart.

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

A bundled skill teaches the model to resolve an entry against the summary it already holds and to
retrieve only what is genuinely missing.

## Retrieval

You and the model both reach the archive through the bundled `seb` command.

| Command | Purpose |
| --- | --- |
| `seb search <query>` | Find archived content by keyword, type, cycle, or turn range |
| `seb show <id>` | Print the full original record, with surrounding turns |
| `seb index` | Show the current Forgotten Index |
| `seb timeline` | Show the turn map for a cycle |
| `seb status` | Show cycles, archive size, and steering state |

Search covers the whole project rather than one session, and every command caps its output and tells
you how to narrow the result.

## Privacy

Sebastian makes no network calls. Archived transcripts, the index, and usage telemetry stay on your
machine.

Transcripts routinely contain secrets. Read `SECURITY.md` before you report a problem or contribute
a test fixture.

## License

MIT. See `LICENSE`.
