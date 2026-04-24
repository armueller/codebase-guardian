#!/usr/bin/env bash
set -euo pipefail

# ─── Codebase Guardian Installer ──────────────────────────────────────────────
#
# Installs Codebase Guardian as a user-level Claude Code hook + MCP server.
# Works on any TypeScript project — install once, works everywhere.
#
# Usage:
#   ./install.sh              # Install from current directory (the cloned repo)
#   ./install.sh --uninstall  # Remove installation
#

GUARDIAN_HOME="${GUARDIAN_HOME:-$HOME/.codebase-guardian}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="0.1.0"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[info]${NC}  $1"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $1"; }
error() { echo -e "${RED}[error]${NC} $1"; }

# ─── Uninstall ────────────────────────────────────────────────────────────────

if [[ "${1:-}" == "--uninstall" ]]; then
  info "Uninstalling Codebase Guardian..."

  # Remove hook from user settings
  SETTINGS_FILE="$HOME/.claude/settings.json"
  if [[ -f "$SETTINGS_FILE" ]]; then
    if command -v jq &>/dev/null; then
      # Remove guardian hooks from PreToolUse
      jq 'if .hooks.PreToolUse then .hooks.PreToolUse |= map(select(.hooks | all(.command | contains("codebase-guardian") | not))) else . end' \
        "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp" && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"
      ok "Removed hook from settings.json"
    else
      warn "jq not found — manually remove codebase-guardian entries from $SETTINGS_FILE"
    fi
  fi

  # Remove MCP server
  if command -v claude &>/dev/null; then
    claude mcp remove codebase-guardian --scope user 2>/dev/null && ok "Removed MCP server" || true
  fi

  # Remove skills
  for skill_name in audit hook-audit review-suggestions; do
    if [[ -d "$HOME/.claude/skills/$skill_name" ]]; then
      rm -rf "$HOME/.claude/skills/$skill_name"
    fi
  done
  ok "Removed skills"

  # Remove install directory (but keep indexes — user may want to preserve)
  if [[ -d "$GUARDIAN_HOME" ]]; then
    read -p "Remove $GUARDIAN_HOME (includes per-project indexes)? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      rm -rf "$GUARDIAN_HOME"
      ok "Removed $GUARDIAN_HOME"
    else
      info "Kept $GUARDIAN_HOME — remove manually when ready"
    fi
  fi

  ok "Uninstall complete"
  exit 0
fi

# ─── Ensure Correct Node Version ─────────────────────────────────────────────

if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use --silent 2>/dev/null || nvm use --silent 22 2>/dev/null || true
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
  nvm use --silent 2>/dev/null || nvm use --silent 22 2>/dev/null || true
fi

# ─── Prerequisites ────────────────────────────────────────────────────────────

info "Checking prerequisites..."

if ! command -v node &>/dev/null; then
  error "Node.js is required. Install it from https://nodejs.org"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  error "npm is required."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 18 ]]; then
  error "Node.js >= 18 required (found v$(node -v))"
  exit 1
fi

if ! command -v claude &>/dev/null; then
  warn "Claude CLI not found — hook and MCP registration will be skipped"
  warn "Install Claude Code CLI and re-run install.sh to complete setup"
fi

ok "Prerequisites met (Node $(node -v))"

# ─── Install Directory ────────────────────────────────────────────────────────

info "Installing to $GUARDIAN_HOME..."

mkdir -p "$GUARDIAN_HOME"/{indexes,logs,suggestions}

# Copy source files
rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude '*.db' \
  "$SCRIPT_DIR/" "$GUARDIAN_HOME/source/"

ok "Source files copied"

# ─── Dependencies ─────────────────────────────────────────────────────────────

info "Installing dependencies..."
cd "$GUARDIAN_HOME/source"
npm install --ignore-scripts 2>&1 | tail -1
npm rebuild better-sqlite3 2>&1 | tail -1
ok "Dependencies installed"

# ─── Build ────────────────────────────────────────────────────────────────────

info "Building TypeScript..."
npm run build 2>&1 | tail -1
ok "Build complete"

# ─── Register MCP Server ─────────────────────────────────────────────────────

if command -v claude &>/dev/null; then
  info "Registering MCP server..."
  claude mcp remove codebase-guardian --scope user 2>/dev/null || true
  claude mcp add codebase-guardian --scope user \
    -- node "$GUARDIAN_HOME/source/dist/mcp-server/index.js" 2>/dev/null
  ok "MCP server registered (user scope)"
else
  warn "Skipping MCP registration (claude CLI not found)"
fi

# ─── Register PreToolUse Hook ─────────────────────────────────────────────────

SETTINGS_FILE="$HOME/.claude/settings.json"
HOOK_COMMAND="$GUARDIAN_HOME/source/node_modules/.bin/tsx $GUARDIAN_HOME/source/src/hooks/pre-edit-validation.ts"

if command -v jq &>/dev/null; then
  info "Registering PreToolUse hook..."

  # Create settings file if it doesn't exist
  mkdir -p "$HOME/.claude"
  if [[ ! -f "$SETTINGS_FILE" ]]; then
    echo '{}' > "$SETTINGS_FILE"
  fi

  # Build the hook entry
  HOOK_ENTRY=$(cat <<HOOKJSON
{
  "matcher": "Edit|Write",
  "hooks": [{
    "type": "command",
    "command": "$HOOK_COMMAND"
  }]
}
HOOKJSON
)

  # Check if guardian hook already exists
  EXISTING=$(jq '.hooks.PreToolUse // [] | map(select(.hooks[]?.command | contains("codebase-guardian"))) | length' "$SETTINGS_FILE" 2>/dev/null || echo "0")

  if [[ "$EXISTING" -gt 0 ]]; then
    # Update existing entry
    jq --argjson hook "$HOOK_ENTRY" '
      .hooks.PreToolUse |= map(
        if (.hooks[]?.command | contains("codebase-guardian"))
        then $hook
        else .
        end
      )
    ' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp" && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"
    ok "Updated existing hook in settings.json"
  else
    # Add new entry
    jq --argjson hook "$HOOK_ENTRY" '
      .hooks.PreToolUse = ((.hooks.PreToolUse // []) + [$hook])
    ' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp" && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"
    ok "Added hook to settings.json"
  fi
else
  warn "jq not found — add this hook manually to $SETTINGS_FILE:"
  echo ""
  echo "  PreToolUse → matcher: \"Edit|Write\""
  echo "  command: \"$HOOK_COMMAND\""
  echo ""
fi

# ─── Install Skills ───────────────────────────────────────────────────────────

info "Installing skills..."
mkdir -p "$HOME/.claude/skills"
for skill_dir in "$GUARDIAN_HOME/source/skills"/*/; do
  skill_name=$(basename "$skill_dir")
  cp -r "$skill_dir" "$HOME/.claude/skills/$skill_name"
done
ok "Skills installed to ~/.claude/skills/"

# ─── Version Stamp ────────────────────────────────────────────────────────────

echo "$VERSION" > "$GUARDIAN_HOME/.version"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$GUARDIAN_HOME/.installed-at"

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Codebase Guardian installed successfully! 🛡️     ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║                                                  ║${NC}"
echo -e "${GREEN}║  Open any TypeScript project in Claude Code      ║${NC}"
echo -e "${GREEN}║  and the guardian will automatically:             ║${NC}"
echo -e "${GREEN}║                                                  ║${NC}"
echo -e "${GREEN}║  • Index your codebase (MCP tools)               ║${NC}"
echo -e "${GREEN}║  • Validate edits for quality (PreToolUse hook)  ║${NC}"
echo -e "${GREEN}║                                                  ║${NC}"
echo -e "${GREEN}║  Run /audit to check documentation coverage.     ║${NC}"
echo -e "${GREEN}║                                                  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Install path:  $GUARDIAN_HOME"
echo "  Version:       $VERSION"
echo "  Update:        cd $(pwd) && ./update.sh"
echo ""
