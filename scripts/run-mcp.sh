#!/usr/bin/env bash
# MCP server launcher. Exits quietly (server unavailable) if the engine isn't
# built yet or Node is missing; Claude Code brings it up on a later session once
# the background build has finished.
set -uo pipefail

DATA="${CLAUDE_PLUGIN_DATA:-}"
[ -n "$DATA" ] || exit 0
SERVER="$DATA/app/dist/mcp-server/index.js"
[ -f "$SERVER" ] || exit 0

# shellcheck source=/dev/null
. "${CLAUDE_PLUGIN_ROOT}/scripts/_guardian-lib.sh"
NODE="$(guardian_resolve_node)" || exit 0

export NODE_PATH="$DATA/app/node_modules"
exec "$NODE" "$SERVER"
