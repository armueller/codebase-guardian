#!/usr/bin/env bash
# Shared helpers for Codebase Guardian plugin scripts. SOURCED, not executed.

# guardian_node_ok <path> : true if $1 is an executable Node >= 18.
guardian_node_ok() {
  local n="$1" major
  [ -x "$n" ] || return 1
  major="$("$n" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  [ -n "$major" ] && [ "$major" -ge 18 ] 2>/dev/null
}

# guardian_resolve_node : print an absolute path to a usable Node >= 18, or return 1.
# Order: cached (.node-bin from a prior build) → PATH → nvm → common locations.
# Keeps the hook hot-path fast by preferring the cached/PATH node before sourcing nvm.
guardian_resolve_node() {
  local data="${CLAUDE_PLUGIN_DATA:-}" cached n

  if [ -n "$data" ] && [ -s "$data/.node-bin" ]; then
    n="$(cat "$data/.node-bin" 2>/dev/null)"
    if guardian_node_ok "$n"; then echo "$n"; return 0; fi
  fi

  if command -v node >/dev/null 2>&1; then
    n="$(command -v node)"
    if guardian_node_ok "$n"; then echo "$n"; return 0; fi
  fi

  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
    nvm use --silent >/dev/null 2>&1 || nvm use --silent 22 >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true
    if command -v node >/dev/null 2>&1; then
      n="$(command -v node)"
      if guardian_node_ok "$n"; then echo "$n"; return 0; fi
    fi
  fi

  for n in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if guardian_node_ok "$n"; then echo "$n"; return 0; fi
  done

  return 1
}

# guardian_sha256 <file> : portable sha256 → stdout (empty on failure).
guardian_sha256() {
  local f="$1"
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$f" 2>/dev/null | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$f" 2>/dev/null | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$f" 2>/dev/null | awk '{print $NF}'
  else cksum "$f" 2>/dev/null | cut -d' ' -f1; fi
}
