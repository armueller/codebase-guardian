#!/usr/bin/env bash
set -euo pipefail

# ─── Codebase Guardian Updater ────────────────────────────────────────────────
#
# Updates an existing Codebase Guardian installation.
# Preserves per-project indexes, configs, and data.
#
# Usage:
#   cd /path/to/codebase-guardian && ./update.sh
#

GUARDIAN_HOME="${GUARDIAN_HOME:-$HOME/.codebase-guardian}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[info]${NC}  $1"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $1"; }
error() { echo -e "${RED}[error]${NC} $1"; }

# ─── Ensure Correct Node Version ─────────────────────────────────────────────

if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use --silent 2>/dev/null || nvm use --silent 22 2>/dev/null || true
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
  nvm use --silent 2>/dev/null || nvm use --silent 22 2>/dev/null || true
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 18 ]]; then
  error "Node.js >= 18 required (found $(node -v))"
  error "Run 'nvm use 22' or install a newer Node version"
  exit 1
fi

# ─── Check Installation ──────────────────────────────────────────────────────

if [[ ! -d "$GUARDIAN_HOME" ]]; then
  error "No installation found at $GUARDIAN_HOME"
  error "Run ./install.sh first"
  exit 1
fi

OLD_VERSION="unknown"
if [[ -f "$GUARDIAN_HOME/.version" ]]; then
  OLD_VERSION=$(cat "$GUARDIAN_HOME/.version")
fi

NEW_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")

info "Updating Codebase Guardian: v${OLD_VERSION} → v${NEW_VERSION}"

# ─── Pull Latest (if in git repo) ────────────────────────────────────────────

if [[ -d "$SCRIPT_DIR/.git" ]]; then
  info "Pulling latest changes..."
  cd "$SCRIPT_DIR"
  git pull --ff-only 2>/dev/null && ok "Git pull complete" || warn "Git pull failed — continuing with current files"
fi

# ─── Update Source ────────────────────────────────────────────────────────────

info "Updating source files..."
rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude '*.db' \
  "$SCRIPT_DIR/" "$GUARDIAN_HOME/source/"
ok "Source files updated"

# ─── Rebuild ──────────────────────────────────────────────────────────────────

info "Installing dependencies..."
cd "$GUARDIAN_HOME/source"
npm install --ignore-scripts 2>&1 | tail -1
npm rebuild better-sqlite3 2>&1 | tail -1
ok "Dependencies installed"

info "Building TypeScript..."
npm run build 2>&1 | tail -1
ok "Build complete"

# ─── Update Skills ────────────────────────────────────────────────────────────

info "Updating skills..."
mkdir -p "$HOME/.claude/skills"
for skill_dir in "$GUARDIAN_HOME/source/skills"/*/; do
  skill_name=$(basename "$skill_dir")
  cp -r "$skill_dir" "$HOME/.claude/skills/$skill_name"
done
ok "Skills updated"

# ─── Update Version ──────────────────────────────────────────────────────────

echo "$NEW_VERSION" > "$GUARDIAN_HOME/.version"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$GUARDIAN_HOME/.updated-at"

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
ok "Updated to v${NEW_VERSION}"
echo ""
echo "  Per-project indexes preserved in: $GUARDIAN_HOME/indexes/"
echo "  Per-project logs preserved in:    $GUARDIAN_HOME/logs/"
echo ""
