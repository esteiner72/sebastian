#!/usr/bin/env bash
# Forwards a Claude Code hook invocation to the bundled CLI: run-hook.sh <hook-name>.
# Fail-open by contract: any missing piece exits 0 so compaction is never blocked.
set -u

hook_name="${1:-}"
[ -n "$hook_name" ] || exit 0

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
entry="$dir/../dist/index.js"

command -v node >/dev/null 2>&1 || exit 0
[ -f "$entry" ] || exit 0

exec node "$entry" hook "$hook_name"
