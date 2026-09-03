#!/usr/bin/env bash
# WHICH zero-memory server this machine talks to — the one answer every
# installer here shares, sourced (not executed) by each of them.
#
# It used to be a per-script default pointing at the author's own network, so a
# guest who ran an installer without knowing about an env var silently got an
# address that means nothing on their machine — and the editor registration, the
# hooks and the daemon could each end up on a different server with all three
# reporting themselves healthy. So: one variable name, one stored answer, and no
# invented default.
#
#   ZM_SERVER_URL=<full …/mcp url>   deliberate override, the only variable
#   ~/.config/zero-memory/config.json {"serverUrl": …}   what the last install
#                                                        stored; the watcher
#                                                        binary reads the same
#   otherwise                        ask (on a terminal) or fail with the fix
#
# Usage in an installer:
#   . "$SCRIPT_DIR/zm-server-url.sh"   # or ../zm-server-url.sh in a checkout
#   zm_resolve_server_url              # sets ZM_SERVER_URL + ZM_BASE_URL
#   zm_store_server_url                # persist for every other client
#
# Both are quiet on success beyond one line, and neither writes anything until
# the address has answered on /healthz.

ZM_CONFIG_FILE="${ZM_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/zero-memory/config.json}"

zm__say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
zm__warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

# The stored address, or empty. Read with jq when available (the file is shared
# with other client settings) and with a narrow sed otherwise.
zm__stored_url() {
  [ -f "$ZM_CONFIG_FILE" ] || return 0
  if command -v jq >/dev/null 2>&1; then
    jq -r '.serverUrl // empty' "$ZM_CONFIG_FILE" 2>/dev/null
  else
    sed -n 's/.*"serverUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      "$ZM_CONFIG_FILE" 2>/dev/null | head -n1
  fi
}

# A bare host is the MCP endpoint the user meant but did not spell out; an
# explicit path is left exactly as given.
zm__normalize_url() {
  case "$1" in
    http://*|https://*) ;;
    *) return 1 ;;
  esac
  local url="${1%/}"
  case "${url#*://}" in
    */*) printf '%s\n' "$url" ;;
    *) printf '%s/mcp\n' "$url" ;;
  esac
}

# Is a zero-memory server actually answering there? Unauthenticated, so it is
# meaningful before any login.
zm__server_alive() {
  curl -fsS --max-time 5 "${1%/mcp}/healthz" >/dev/null 2>&1
}

# Sets ZM_SERVER_URL (full …/mcp endpoint) and ZM_BASE_URL (its origin, for the
# OAuth/dashboard lines installers print). Exits non-zero when it cannot get a
# live address — deliberately, so nothing is registered against a guess.
zm_resolve_server_url() {
  local candidate="${ZM_SERVER_URL:-}" source='ZM_SERVER_URL'

  if [ -z "$candidate" ]; then
    candidate="$(zm__stored_url)"
    [ -n "$candidate" ] && source="$ZM_CONFIG_FILE"
  fi
  if [ -z "$candidate" ] && [ -t 0 ]; then
    printf 'Which zero-memory server should this machine use?\n'
    printf '  e.g. https://memory.example.com/mcp (or http://host:8787/mcp on a LAN)\n'
    printf 'Server URL: '
    read -r candidate
    source='answer'
  fi
  if [ -z "$candidate" ]; then
    zm__warn "No zero-memory server given and none stored on this machine."
    zm__warn "Re-run with ZM_SERVER_URL=<url>, or run this from a terminal to"
    zm__warn "be asked for it. Nothing was changed."
    return 1
  fi

  local url
  if ! url="$(zm__normalize_url "$candidate")"; then
    zm__warn "\"$candidate\" is not an http(s) URL. Nothing was changed."
    return 1
  fi

  zm__say "Checking ${url%/mcp}/healthz ..."
  if ! zm__server_alive "$url"; then
    zm__warn "No zero-memory server answered at ${url%/mcp}/healthz."
    zm__warn "Check the address, the network, and that the server is up."
    zm__warn "Nothing was changed (from: $source)."
    return 1
  fi
  zm__say "server reachable at $url"

  ZM_SERVER_URL="$url"
  ZM_BASE_URL="${url%/mcp}"
  export ZM_SERVER_URL ZM_BASE_URL
}

# Persist the resolved address so the watcher binary, its hooks and the next
# install all read the same one. Other keys in the file are preserved.
zm_store_server_url() {
  [ -n "${ZM_SERVER_URL:-}" ] || return 0
  mkdir -p "$(dirname "$ZM_CONFIG_FILE")"
  if command -v jq >/dev/null 2>&1 && [ -s "$ZM_CONFIG_FILE" ]; then
    local merged
    merged="$(jq --arg url "$ZM_SERVER_URL" '.serverUrl = $url' \
      "$ZM_CONFIG_FILE" 2>/dev/null)" || {
      zm__warn "$ZM_CONFIG_FILE is not valid JSON — leaving it untouched."
      return 0
    }
    printf '%s\n' "$merged" > "$ZM_CONFIG_FILE"
  else
    printf '{\n  "serverUrl": "%s"\n}\n' "$ZM_SERVER_URL" > "$ZM_CONFIG_FILE"
  fi
  chmod 0600 "$ZM_CONFIG_FILE" 2>/dev/null || true
  zm__say "Stored server -> $ZM_CONFIG_FILE (read by the watcher and its hooks)"
}
