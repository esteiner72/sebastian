#!/usr/bin/env bash
# Installs Sebastian as a Claude Code plugin from this clone, then says what to check.
#
# The build is the step that cannot fail quietly. `hooks/run-hook.sh` exits 0 when dist/index.js is
# absent, which is correct for the fail-open contract and means a plugin installed without a build
# loads, runs, and does nothing. So this script refuses to finish without that file.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v claude >/dev/null 2>&1 || {
  echo "setup: the claude command is not on PATH; install Claude Code first." >&2
  exit 1
}

echo "==> npm install"
npm install

echo "==> npm run build"
npm run build

[ -f dist/index.js ] || {
  echo "setup: the build produced no dist/index.js, so the hooks would do nothing. Stopping." >&2
  exit 1
}

echo "==> claude plugin marketplace add ./"
claude plugin marketplace add ./

# `claude plugin install` copies this working tree into the plugin cache, and the hooks run that
# copy — not this directory. `claude plugin update` is keyed on the version in plugin.json, so it
# refuses to refresh a same-version build and leaves the hooks on stale code. Uninstalling first is
# therefore the only way to make a rebuild reach the hooks, which is why this script is the update
# path and `npm run build` alone is not.
echo "==> claude plugin uninstall sebastian@sebastian (refreshing the installed copy)"
claude plugin uninstall sebastian@sebastian >/dev/null 2>&1 || true

echo "==> claude plugin install sebastian@sebastian"
claude plugin install sebastian@sebastian

# The CLI on PATH points at this working tree while the hooks run the copy. If the two disagree, the
# archive is written by one build and reported on by another, which silently invalidates a field
# test — so the match is verified here rather than assumed.
installed="$(node -e '
  const fs = require("node:fs");
  const path = process.env.HOME + "/.claude/plugins/installed_plugins.json";
  const entry = JSON.parse(fs.readFileSync(path, "utf8")).plugins["sebastian@sebastian"];
  process.stdout.write(entry?.[0]?.installPath ?? "");
' 2>/dev/null)"

if [ -n "$installed" ] && cmp -s "dist/index.js" "$installed/dist/index.js"; then
  echo "==> installed copy matches this build"
else
  echo "setup: the installed plugin does not match this build; the hooks would run stale code." >&2
  echo "setup: expected $installed/dist/index.js to match ./dist/index.js" >&2
  exit 1
fi

# The hooks and the skill reach the CLI through ${CLAUDE_PLUGIN_ROOT}, so `seb` never has to be on
# PATH for the loop to work. A human checking on the loop wants the short name anyway, and a global
# link is the only thing here that can fail for reasons outside this repository — a read-only npm
# prefix, a name already taken — so it is attempted and reported, never required.
echo "==> npm link (optional, puts seb on PATH)"
if npm link >/dev/null 2>&1; then
  check="seb status"
  linked="yes"
else
  check="node $(pwd)/dist/index.js status"
  linked="no"
fi

cat <<DONE

Installed. Restart Claude Code, then check it is wired up:

  $check

Before the first compaction that reports no archive yet, which is correct. After one it names each
hook and when it last ran. If it still reports no archive after a compaction, the hooks are not
firing — say so rather than assuming a quiet fortnight.

Pull a new version with: git pull && npm run setup, then restart Claude Code. A plain build does
not reach the hooks, because the install is a copy.
DONE

if [ "$linked" = "no" ]; then
  cat <<DONE
npm link did not succeed, which changes nothing about the plugin. For a shorter command, add:

  alias seb='node $(pwd)/dist/index.js'

DONE
fi
