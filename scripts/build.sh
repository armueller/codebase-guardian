#!/usr/bin/env bash
# Heavy build, launched detached by bootstrap.sh. Copies the plugin source into
# ${CLAUDE_PLUGIN_DATA}/app, installs deps (incl. native better-sqlite3),
# compiles TypeScript, and stamps success. Writes only under
# ${CLAUDE_PLUGIN_DATA} (${CLAUDE_PLUGIN_ROOT} is a read-only cache).
set -uo pipefail

ROOT="${CLAUDE_PLUGIN_ROOT:?}"
DATA="${CLAUDE_PLUGIN_DATA:?}"
# shellcheck source=/dev/null
. "$ROOT/scripts/_guardian-lib.sh"

STAMP="$DATA/.build-stamp"
LOCK="$DATA/.build.lock"
APP="$DATA/app"
mkdir -p "$DATA"

# Single-writer lock, self-healing (removed on any exit).
echo "$$" > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

NODE="$(guardian_resolve_node)" || {
  log "ERROR: Node.js >= 18 not found (PATH or nvm). Install Node and start a new session to retry."
  exit 1
}
log "Using node: $NODE ($("$NODE" -v))"
printf '%s' "$NODE" > "$DATA/.node-bin"          # cache for the fast hook/MCP wrappers
NODE_DIR="$(dirname "$NODE")"

# Sync plugin source into APP (preserve node_modules/dist across rebuilds).
log "Syncing source into $APP ..."
mkdir -p "$APP"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules --exclude dist --exclude .git "$ROOT"/ "$APP"/
else
  # Fallback: refresh source files, keep node_modules/dist.
  for item in src scripts skills hooks templates python requirements-python.txt package.json package-lock.json tsconfig.json .claude-plugin .mcp.json; do
    [ -e "$ROOT/$item" ] || continue
    rm -rf "$APP/$item"; cp -R "$ROOT/$item" "$APP/$item"
  done
fi

cd "$APP" || { log "ERROR: cannot cd to $APP"; exit 1; }

log "Installing dependencies (slow — ~550MB) ..."
PATH="$NODE_DIR:$PATH" npm install --ignore-scripts >>"$DATA/bootstrap.log" 2>&1 || { log "ERROR: npm install failed"; exit 1; }
PATH="$NODE_DIR:$PATH" npm rebuild better-sqlite3 >>"$DATA/bootstrap.log" 2>&1 || { log "ERROR: better-sqlite3 rebuild failed (missing C/C++ build toolchain?)"; exit 1; }

log "Compiling TypeScript ..."
PATH="$NODE_DIR:$PATH" npm run build >>"$DATA/bootstrap.log" 2>&1 || { log "ERROR: tsc build failed"; exit 1; }

if [ ! -f "$APP/dist/mcp-server/index.js" ] || [ ! -f "$APP/dist/hooks/pre-edit-validation.js" ]; then
  log "ERROR: build produced no dist artifacts"
  exit 1
fi

# Provision the Python toolchain venv at $DATA/pyenv (ruff/pydoclint/pyright/griffe/jedi
# for the Python validation path). OPTIONAL and fail-open: any failure only disables
# Python validation — it never fails the build or the TypeScript path. The guardian_py
# helper source itself travels in $APP/python (synced above); this only builds the venv.
if command -v python3 >/dev/null 2>&1 \
   && python3 -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 9) else 1)' >/dev/null 2>&1; then
  PYENV_DIR="$DATA/pyenv"
  [ -x "$PYENV_DIR/bin/python" ] || python3 -m venv "$PYENV_DIR" >>"$DATA/bootstrap.log" 2>&1 \
    || log "WARN: venv creation failed — Python validation disabled"
  if [ -x "$PYENV_DIR/bin/pip" ] && [ -f "$APP/requirements-python.txt" ]; then
    "$PYENV_DIR/bin/pip" install --quiet --upgrade pip >>"$DATA/bootstrap.log" 2>&1 || true
    if "$PYENV_DIR/bin/pip" install --quiet -r "$APP/requirements-python.txt" >>"$DATA/bootstrap.log" 2>&1; then
      log "Python toolchain provisioned ($("$PYENV_DIR/bin/python" --version 2>&1))"
    else
      log "WARN: pip install of Python toolchain failed — Python validation disabled"
    fi
  fi
elif command -v python3 >/dev/null 2>&1; then
  log "WARN: python3 is $(python3 -V 2>&1) but guardian_py needs >= 3.9 — Python validation disabled (TypeScript unaffected)"
else
  log "WARN: python3 not found — Python validation disabled (TypeScript unaffected)"
fi

# Stamp success — the fast path keys off this next session.
guardian_sha256 "$ROOT/package.json" > "$STAMP"
log "Codebase Guardian build complete. Validation + index tools are now active."
