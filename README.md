# Sebastian

Sebastian is a Claude Code plugin that makes compaction recoverable. He is also my dog.

When Claude Code compacts a conversation, a summary replaces the transcript. The raw transcript
survives on disk, but nothing tells the model what the summary dropped, so it never looks. Sebastian
archives the transcript, works out what the summary lost, and hands the model an index of the
missing pieces along with the commands that retrieve them.

## Status

Pre-release. Nothing here is installable yet, and the package is not published. The design lives in
`docs/specs/2026-08-30-sebastian.md` and the implementation is in progress.

## How it works

Each compaction cycle runs four steps. The fourth feeds the first of the next cycle.

1. **Steer.** A `PreCompact` hook writes the compact instructions for the compaction that is about
   to run, telling the summarizer to keep identifiers verbatim.
2. **Archive.** The same hook copies the new part of the transcript into a local SQLite database and
   indexes it for full-text search.
3. **Reconcile.** A `PostCompact` hook receives the summary, diffs it against the identifiers found
   in the transcript, and records what the summary dropped.
4. **Inject.** A `SessionStart` hook gives the model a Forgotten Index: what the archive holds that
   the summary does not, and the exact command to retrieve each entry.

What each cycle drops steers the next cycle's instructions, so summaries improve as a project
accumulates history.

## Retrieval

You and the model both reach the archive through the bundled `seb` command.

| Command | Purpose |
| --- | --- |
| `seb search <query>` | Find archived content by keyword, type, cycle, or turn range |
| `seb show <id>` | Print the full original record, with surrounding turns |
| `seb index` | Show the current Forgotten Index |
| `seb timeline` | Show the turn map for a cycle |
| `seb status` | Show cycles, archive size, and steering state |

## Privacy

Sebastian makes no network calls. Archived transcripts, the index, and usage telemetry stay on your
machine.

Transcripts routinely contain secrets. Read `SECURITY.md` before you report a problem or contribute
a test fixture.

## License

MIT. See `LICENSE`.
