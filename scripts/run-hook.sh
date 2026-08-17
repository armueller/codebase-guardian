#!/usr/bin/env bash
# PreToolUse (Edit|Write) launcher. Fails OPEN (exit 0, no decision) whenever the
# engine can't run — not built yet, or no Node — so edits are NEVER blocked
# during the first-run background build or on a misconfigured machine.
set -uo pipefail

DATA="${CLAUDE_PLUGIN_DATA:-}"
[ -n "$DATA" ] || exit 0
HOOK="$DATA/app/dist/hooks/pre-edit-validation.js"
[ -f "$HOOK" ] || exit 0                      # engine not built yet → allow

# shellcheck source=/dev/null
. "${CLAUDE_PLUGIN_ROOT}/scripts/_guardian-lib.sh"
NODE="$(guardian_resolve_node)" || exit 0     # no Node → allow

export NODE_PATH="$DATA/app/node_modules"
exec "$NODE" "$HOOK"                           # stdin (the hook payload) passes through
