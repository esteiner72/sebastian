#!/usr/bin/env bash
# Runs `claude plugin validate --strict` against the tree as a checkout would see it:
# tracked and unignored files only. Gitignored local files (CLAUDE.local.md,
# .claude/settings.local.json) sit at the plugin root but never ship, and would
# otherwise fail strict validation on every developer machine.
set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git ls-files --cached --others --exclude-standard | rsync -a --files-from=- . "$tmp/"
claude plugin validate "$tmp" --strict
