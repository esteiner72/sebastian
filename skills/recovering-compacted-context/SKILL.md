---
name: recovering-compacted-context
description: Use this skill after a conversation is compacted, whenever a Forgotten Index appears in the context, when you are unsure what earlier work in this session established, or when the user refers to something that happened before the summary. It explains how to read the index Sebastian injects and how to retrieve the original records with the `seb` command.
---

# Recovering compacted context

Compaction replaces the transcript with a summary, and the summary drops detail. Sebastian archives
the transcript before each compaction, works out which anchors the summary failed to carry, and
injects a Forgotten Index. This skill tells you how to read that index and how to get an original
record back.

## Run the command

Every retrieval command in the index is written as `seb <command>`. Run it as:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" <command>
```

If `seb` is on the PATH, `seb <command>` does the same thing. An index whose footer reads
`seb show 344e260c/<id>` therefore retrieves its entry `t41e1` with
`node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" show 344e260c/t41e1`.

## Read the index before you retrieve

The index costs the user context. Retrieval costs more. Work in this order:

1. **Check the summary you already hold.** You have the compaction summary in context. Most entries
   describe material the summary covers in different words.
2. **Retrieve only what is absent.** If the summary does not carry the detail and the task needs it,
   run `seb show <id>`.
3. **Never re-summarize the archive.** The archive is a place to look things up, not material to
   fold back into the conversation.

## What the entries mean

An index entry names an anchor id, a type, and enough of the content to recognize it. The footer
names the retrieval command once, with the session prefix that makes it unambiguous:

```
- t41e1 error: ENOENT: no such file or directory, open 'sebastian.db'
Run `seb index --dropped` for the full list; `seb show 344e260c/<id>` retrieves an original.
```

The id encodes turn, type, and position, so `t41e1` is the first error of turn 41. Ids restart in
every session, so an archive holding several sessions can hold the same id more than once. Use the
prefixed form from the footer, `seb show 344e260c/t41e1`; it always resolves. The bare id resolves
only while one session holds it.

Types are `error`, `answer`, `edit`, `user`, `cmd`, `read`, and `url`. An `answer` anchor points at
an explanation you gave earlier, which is the class compaction destroys first.

Entries under **Possibly paraphrased — verify against the summary before retrieving** scored a
partial match against the summary. Resolve these against the summary in your context first. Retrieve
one only when the summary turns out not to carry it.

The counts line reports every type that was dropped, including the types that spend no entry of
their own. A non-zero `user` count means the summary dropped an instruction the user gave you: list
those with `seb index --dropped`, because breaking a forgotten instruction is the most expensive
mistake available here.

## An unreconciled index

A block headed **Forgotten Index — unreconciled** means no summary reached Sebastian for that
compaction, so nothing was checked against one. The anchors listed existed before the boundary and
their fate is unknown. Nothing in that block is a loss claim. Treat each entry as a question to
answer against the summary, and retrieve only what the summary is missing.

## Commands

| Command | What it does |
| --- | --- |
| `seb search <query>` | Search the archive by keyword. Flags: `--type`, `--cycle`, `--session`, `--turn A:B`, `--limit` |
| `seb show <id>` | Print the original record. `<id>` is an anchor id or `cycle:turn`. `--context N` adds neighbouring turns |
| `seb index` | Print the current Forgotten Index. `--dropped` and `--all` list every anchor, `--raw` adds match scores |
| `seb timeline` | Map the turns of a cycle. `--cycle N` narrows it |
| `seb status` | Report cycles, archive size, and the steering in force |
| `seb log` | Show what the hooks did and when. Diagnoses the loop; it retrieves no dropped content. Flags: `--hook`, `--level info\|warn\|error`, `--limit` |
| `seb report` | Print a JSON summary of the loop's own behaviour. For the maintainer, not for retrieval: it holds counts and timestamps, never archived content |
| `seb reconcile` | Judge any compaction whose bookkeeping did not finish, so its index becomes available. The loop does this itself at the next compaction; run it to avoid waiting |

Search covers the whole project, not only this session, so it finds work from a session whose id you
do not know. Every retrieval command caps its output and tells you how to narrow the result.

The archive is a SQLite database at `~/.claude/sebastian/<project-slug>/sebastian.db`, holding six
tables: `messages`, `anchors`, `cycles`, `pending`, `log`, and `telemetry`. A question no command
answers can be asked with SQL directly. One diagnostic rule: when the archive file exists, every hook
invocation writes exactly one `log` row with a non-null `ms`, so zero rows for a hook means the hook
was never invoked, not that it ran and did nothing.

## Worked example

The index reports a dropped error anchor `t41e1` and the summary says only that "the store failed to
open". You need the exact failure to fix it, and the summary does not carry it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" show t41e1 --context 2
```

That prints the original tool result and the two turns on either side. If you need every place the
same failure appeared:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" search "no such file or directory" --type error
```
