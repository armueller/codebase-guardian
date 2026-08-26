#!/usr/bin/env bash
# PreToolUse (Grep|Glob|Bash|semantic-search) launcher for the search-hint nudge.
# Fails SILENT (exit 0, no stdout) whenever the engine can't run — not built yet, or no
# Node — so it never blocks a search and never injects malformed hook output.
set -uo pipefail

DATA="${CLAUDE_PLUGIN_DATA:-}"
[ -n "$DATA" ] || exit 0
HOOK="$DATA/app/dist/hooks/search-hint.js"
[ -f "$HOOK" ] || exit 0                      # engine not built yet → no nudge

# shellcheck source=/dev/null
. "${CLAUDE_PLUGIN_ROOT}/scripts/_guardian-lib.sh"
NODE="$(guardian_resolve_node)" || exit 0     # no Node → no nudge

export NODE_PATH="$DATA/app/node_modules"
exec "$NODE" "$HOOK"                           # stdin (the hook payload) passes through
