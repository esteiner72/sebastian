#!/usr/bin/env bash
# Runs `claude plugin validate --strict` against the tree as a checkout would see it:
# tracked and unignored files only. Gitignored local files (CLAUDE.local.md,
# .claude/settings.local.json) sit at the plugin root but never ship, and would
# otherwise fail strict validation on every developer machine.
#
# Both manifests are validated. A directory holding marketplace.json validates as a
# marketplace and never as a plugin, so the plugin manifest is named directly.
set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git ls-files --cached --others --exclude-standard | rsync -a --files-from=- . "$tmp/"
claude plugin validate "$tmp" --strict
claude plugin validate "$tmp/.claude-plugin/plugin.json" --strict
