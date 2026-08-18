#!/usr/bin/env bash
# SessionStart hook. Ensures the plugin's native deps + compiled dist exist in
# ${CLAUDE_PLUGIN_DATA}/app. Fast no-op when already built for the current
# package.json. Otherwise launches the (heavy, ~550MB) build in the BACKGROUND
# so the session is never blocked, and prints a one-time notice.
#
# Idempotent & self-healing: the success stamp is written only when the build
# finishes, so an interrupted build simply retries on the next session.
set -uo pipefail

ROOT="${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT not set}"
DATA="${CLAUDE_PLUGIN_DATA:?CLAUDE_PLUGIN_DATA not set}"
# shellcheck source=/dev/null
. "$ROOT/scripts/_guardian-lib.sh"

mkdir -p "$DATA"
STAMP="$DATA/.build-stamp"
LOCK="$DATA/.build.lock"
PKG_HASH="$(guardian_sha256 "$ROOT/package.json")"

# Fast path: dist present AND built for the current package.json → nothing to do.
if [ -f "$DATA/app/dist/mcp-server/index.js" ] && [ -f "$DATA/app/dist/hooks/pre-edit-validation.js" ] \
   && [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$PKG_HASH" ]; then
  exit 0
fi

# A build is already running (another session)? Let it finish, unless the lock
# is stale (>30 min → assume the build died and retry).
if [ -f "$LOCK" ]; then
  if [ -n "$(find "$LOCK" -mmin -30 2>/dev/null)" ]; then exit 0; fi
  rm -f "$LOCK"
fi

# Launch the build detached so SessionStart returns immediately.
nohup bash "$ROOT/scripts/build.sh" >"$DATA/bootstrap.log" 2>&1 &
disown 2>/dev/null || true

echo "🛡️ Codebase Guardian is building its engine in the background (first run or update — a few minutes; downloads ~550MB of native deps). Edit validation and index tools activate automatically once ready. Until then, edits are allowed through."
exit 0
