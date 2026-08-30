# Security policy

## Supported versions

Sebastian is pre-release. Only the current `main` branch is supported. No versions are published
yet, and fixes are not backported.

## Report a vulnerability

Report vulnerabilities through GitHub private vulnerability reporting on this repository. Open the
**Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security
problem.

Expect an acknowledgement within seven days.

## What Sebastian handles

Sebastian archives raw Claude Code transcripts. A transcript can contain anything that passed
through a session: prompts, file contents, command output, absolute paths, and credentials that
appeared in a tool result. Treat the archive as sensitive data.

One property limits the exposure: Sebastian makes no network calls. Archives, the index, and
telemetry stay on the machine that produced them.

## Contribute test fixtures safely

Never commit a real transcript. Synthesize fixtures, or scrub them before they reach a branch.
GitHub push protection catches known credential formats. It does not catch internal hostnames,
customer names, private source code, or a credential it cannot pattern-match.

## In scope

- Archived data that another local user can read
- A code path that writes transcript content outside the plugin data directory
- A hook failure that blocks or corrupts compaction
- Command injection through archived content that reaches a shell

## Out of scope

- Secrets that a transcript holds because the session held them. Sebastian records what Claude Code
  already wrote to disk.
