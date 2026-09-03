#!/usr/bin/env bash
# Deploy the zero-memory (ZM) integration into a machine's GLOBAL Codex config,
# OR package a guest bundle for a LAN machine — the Codex sibling of
# deploy-zm-cursor.sh / deploy-zm-claude.sh. Run ON A CLIENT machine that
# already reaches the ZM server. Idempotent.
#
# Codex mirrors the Claude Code contour and, like Claude and Cursor, ships as a
# real PLUGIN (.codex-plugin) carrying the hooks + a memory-first skill. Codex's
# hook I/O is byte-identical to Claude's (same stdin fields +
# hookSpecificOutput/additionalContext frame), so the watcher's `--client codex`
# reuses the Claude hook I/O. It wires, all at user scope:
#   1. the `zero-memory` MCP server -> $ZM_SERVER_URL via `codex mcp add` (NOT in the
#      plugin — a plugin-bundled server namespaces its tools plugin-<slug>-…)
#   2. the watcher binary (~/.local/bin) + the `zero-memory` plugin, installed
#      from a generated LOCAL marketplace (Settings -> Plugins), whose hooks are:
#        SessionStart      -> brief session-start
#        UserPromptSubmit  -> brief task + status
#        Stop              -> ingest
#        PreCompact        -> checkpoint (captures the epoch about to be
#                             condensed; capture only — Codex reads a hook's
#                             stdout as structured output, so nothing printed
#                             there reaches the model writing the summary)
#      and whose skill carries the memory-first mandate
#   3. MIGRATION off any legacy config.toml [hooks] block + AGENTS.md ZM section
#   4. a reminder to finish OAuth + TRUST the plugin hooks (Codex /hooks trust)
#
# Two modes, chosen by whether an export dir is given:
#   bash deploy-zm-codex.sh                       # INSTALL on this machine
#   bash deploy-zm-codex.sh /path/to/bundle-dir   # PACKAGE a guest bundle
#   ZM_SERVER_URL=https://memory.example.com/mcp bash deploy-zm-codex.sh
set -euo pipefail

EXPORT_DIR="${1:-}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG_TOML="$CODEX_DIR/config.toml"
AGENTS_MD="$CODEX_DIR/AGENTS.md"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_BEGIN="# >>> zero-memory hooks (managed by deploy-zm-codex.sh) >>>"
HOOKS_END="# <<< zero-memory hooks <<<"
RULE_MARKER="## zero-memory (ZM): first knowledge source"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

# --- 0a. is this bundle even for this machine? ------------------------------
# A published archive is per-platform; picking the wrong one from a download
# page is easy and its failure (a binary that will not exec) is confusing. The
# bundle declares its platform in bundle.json; refuse early, before anything is
# copied. A staged folder built without a manifest passes with a warning.
for cand in "$SCRIPT_DIR/zm-platform.sh" "$SCRIPT_DIR/../zm-platform.sh"; do
  # shellcheck source=scripts/zm-platform.sh
  [ -f "$cand" ] && { . "$cand"; break; }
done
if command -v zm_require_matching_platform >/dev/null 2>&1; then
  zm_require_matching_platform "$SCRIPT_DIR" || exit 1
fi

# The binary's file name is platform-dependent (Windows needs the extension or
# nothing will run it), and the bundle, the install destination and the plugin
# wiring all have to spell it identically. zm-platform.sh is the one authority;
# the fallback keeps a bundle staged before this existed installable.
ZM_BIN_FILE="zero-memory-watcher"
command -v zm_binary_file >/dev/null 2>&1 && ZM_BIN_FILE="$(zm_binary_file)"
DEST_BIN="$HOME/.local/bin/$ZM_BIN_FILE"

# --- 0. locate repo/bundle root + resolve the watcher binary ----------------
MARKET_ROOT=""
for d in "$SCRIPT_DIR" "$SCRIPT_DIR/.." "$SCRIPT_DIR/../.."; do
  if [ -f "$d/scripts/build-watcher.sh" ] || [ -f "$d/SHA256SUMS" ]; then
    MARKET_ROOT="$(cd "$d" && pwd)"
    break
  fi
done

SRC_BIN=""; DIGEST=""; BINARY_SOURCE=""
if [ -f "$SCRIPT_DIR/$ZM_BIN_FILE" ]; then
  SRC_BIN="$SCRIPT_DIR/$ZM_BIN_FILE"
  DIGEST="$SCRIPT_DIR/SHA256SUMS"; [ -f "$DIGEST" ] || DIGEST="$SRC_BIN.sha256"
  BINARY_SOURCE="bundled next to script (no rebuild)"
elif [ -n "$MARKET_ROOT" ] && [ -f "$MARKET_ROOT/scripts/build-watcher.sh" ] && command -v bun >/dev/null 2>&1; then
  BINARY_SOURCE="rebuilt from source"
  say "Building watcher binary…"
  (cd "$MARKET_ROOT" && bash scripts/build-watcher.sh >/dev/null)
  SRC_BIN="$MARKET_ROOT/dist/$ZM_BIN_FILE"
  DIGEST="$MARKET_ROOT/dist/$ZM_BIN_FILE.sha256"
elif command -v zero-memory-watcher >/dev/null 2>&1; then
  SRC_BIN="$(command -v zero-memory-watcher)"; BINARY_SOURCE="existing on PATH (no rebuild)"
fi
[ -n "$SRC_BIN" ] || { echo "ERROR: no watcher binary (none bundled, no source to build, none on PATH)." >&2; exit 1; }
say "Binary source: $BINARY_SOURCE"
if [ -n "$DIGEST" ] && [ -f "$DIGEST" ]; then
  (cd "$(dirname "$SRC_BIN")" && sha256sum -c "$DIGEST" >/dev/null 2>&1) \
    && say "Binary digest verified" || warn "digest check did not pass — continuing"
fi

# ============================================================================
# EXPORT MODE — stage a guest bundle (binary + digest + this script), no install.
# ============================================================================
if [ -n "$EXPORT_DIR" ]; then
  say "Export mode: staging a guest bundle — NOT installing on this machine."
  mkdir -p "$EXPORT_DIR"
  install -m 0755 "$SRC_BIN" "$EXPORT_DIR/zero-memory-watcher"
  repo_hash="$(awk '/^[0-9a-f]{64}[[:space:]]/{print $1; exit}' "${MARKET_ROOT:-/nonexistent}/SHA256SUMS" 2>/dev/null || true)"
  export_hash="$(sha256sum "$EXPORT_DIR/zero-memory-watcher" | awk '{print $1}')"
  if [ -n "$repo_hash" ] && [ "$repo_hash" = "$export_hash" ]; then
    cp "$MARKET_ROOT/SHA256SUMS" "$EXPORT_DIR/SHA256SUMS"
  else
    (cd "$EXPORT_DIR" && sha256sum zero-memory-watcher > SHA256SUMS)
  fi
  install -m 0755 "$SCRIPT_DIR/$(basename "$0")" "$EXPORT_DIR/deploy-zm-codex.sh"
  # The installer sources this for the server address — a guest copy without it
  # would have no way to ask for, check or store one.
  for cand in "$SCRIPT_DIR/zm-server-url.sh" "${MARKET_ROOT:-/nonexistent}/scripts/zm-server-url.sh"; do
    [ -f "$cand" ] && { install -m 0755 "$cand" "$EXPORT_DIR/zm-server-url.sh"; break; }
  done
  [ -f "$EXPORT_DIR/zm-server-url.sh" ] || warn "missing zm-server-url.sh — not staged."
  if [ -n "$MARKET_ROOT" ] && [ -d "$MARKET_ROOT/plugins/zero-memory-codex" ]; then
    rm -rf "$EXPORT_DIR/plugins/zero-memory-codex"
    mkdir -p "$EXPORT_DIR/plugins"
    cp -r "$MARKET_ROOT/plugins/zero-memory-codex" "$EXPORT_DIR/plugins/zero-memory-codex"
  fi
  say "Guest bundle staged: $EXPORT_DIR"
  say "On the guest:  cd $EXPORT_DIR && bash deploy-zm-codex.sh   (then: zero-memory-watcher login)"
  exit 0
fi

# ============================================================================
# INSTALL MODE — wire THIS machine's Codex config.
# ============================================================================
mkdir -p "$CODEX_DIR" "$HOME/.local/bin"

# --- which server? (asked, checked, then stored — see zm-server-url.sh) ------
# Install mode only: packaging a bundle above needs no server. Resolved before
# anything is written, so Codex's registration and the hooks' runtime target
# cannot end up on two different instances.
for cand in "$SCRIPT_DIR/zm-server-url.sh" "$SCRIPT_DIR/../zm-server-url.sh"; do
  # shellcheck source=scripts/zm-server-url.sh
  [ -f "$cand" ] && { . "$cand"; break; }
done
if ! command -v zm_resolve_server_url >/dev/null 2>&1; then
  echo "ERROR: zm-server-url.sh not found next to this script." >&2
  exit 1
fi
zm_resolve_server_url || exit 1
zm_store_server_url
BASE_URL="$ZM_BASE_URL"

# --- install the watcher binary ---------------------------------------------
if [ "$SRC_BIN" != "$DEST_BIN" ]; then
  install -m 0755 "$SRC_BIN" "$DEST_BIN"; say "Installed watcher binary -> $DEST_BIN"
else
  say "Using existing watcher binary at $DEST_BIN"
fi

# --- register the MCP server (codex mcp add -> ~/.codex/config.toml) ---------
# `codex mcp add` manages the [mcp_servers.zero-memory] table; remove first so a
# changed URL re-points cleanly. Codex OAuth-authorizes the server itself.
if command -v codex >/dev/null 2>&1; then
  say "Registering MCP server 'zero-memory' -> $ZM_SERVER_URL (codex mcp add)"
  codex mcp remove zero-memory >/dev/null 2>&1 || true
  codex mcp add zero-memory --url "$ZM_SERVER_URL" || warn "codex mcp add failed — add it manually"
else
  warn "'codex' not on PATH — add the MCP server manually: codex mcp add zero-memory --url $ZM_SERVER_URL"
fi

# --- install the Codex PLUGIN (hooks + memory-first skill) ------------------
# Codex plugins install from a marketplace SNAPSHOT, so generate a LOCAL
# marketplace whose single plugin is this repo's plugins/zero-memory-codex, then
# `codex plugin add` it. Hooks live in the plugin (hooks/hooks.json); each hook
# command is rewritten to the absolute installed-binary path.
PLUGIN_SRC="$MARKET_ROOT/plugins/zero-memory-codex"
MKT_ROOT="$CODEX_DIR/zero-memory-marketplace"
MKT_NAME="zero-memory-local"
if command -v codex >/dev/null 2>&1 && [ -d "$PLUGIN_SRC" ]; then
  say "Staging local plugin marketplace -> $MKT_ROOT"
  rm -rf "$MKT_ROOT"
  mkdir -p "$MKT_ROOT/.agents/plugins" "$MKT_ROOT/plugins"
  cp -r "$PLUGIN_SRC" "$MKT_ROOT/plugins/zero-memory"
  tmp="$(mktemp)"
  jq --arg bin "$DEST_BIN" '
    .hooks |= map_values(map(.hooks |= map(.command |= sub("^zero-memory-watcher"; $bin))))
  ' "$MKT_ROOT/plugins/zero-memory/hooks/hooks.json" > "$tmp" \
    && mv "$tmp" "$MKT_ROOT/plugins/zero-memory/hooks/hooks.json"
  cat > "$MKT_ROOT/.agents/plugins/marketplace.json" <<EOF
{
  "name": "$MKT_NAME",
  "plugins": [
    {
      "name": "zero-memory",
      "source": { "source": "local", "path": "./plugins/zero-memory" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_USE" },
      "category": "Productivity"
    }
  ]
}
EOF
  say "Installing plugin (codex plugin add zero-memory@$MKT_NAME)"
  codex plugin marketplace remove "$MKT_NAME" >/dev/null 2>&1 || true
  codex plugin marketplace add "$MKT_ROOT" || warn "codex plugin marketplace add failed"
  codex plugin remove zero-memory >/dev/null 2>&1 || true
  codex plugin add "zero-memory@$MKT_NAME" \
    || warn "codex plugin add failed — install manually from $MKT_ROOT"
else
  warn "'codex' not on PATH or plugin source missing — install the plugin from $PLUGIN_SRC"
fi

# --- migrate OFF the legacy config.toml [hooks] + AGENTS.md rule -------------
# The plugin now owns the hooks AND the memory-first guidance (skill), so strip
# any earlier deploy's managed config.toml [hooks] block and AGENTS.md section —
# otherwise hooks would double-fire and the rule would duplicate.
if [ -f "$CONFIG_TOML" ] && grep -qF "$HOOKS_BEGIN" "$CONFIG_TOML"; then
  tmp="$(mktemp)"
  sed "/$(printf '%s' "$HOOKS_BEGIN" | sed 's/[.[\*^$/]/\\&/g')/,/$(printf '%s' "$HOOKS_END" | sed 's/[.[\*^$/]/\\&/g')/d" "$CONFIG_TOML" > "$tmp" && mv "$tmp" "$CONFIG_TOML"
  say "Migrated: removed the legacy [hooks] block from $CONFIG_TOML (the plugin owns hooks now)"
fi
if [ -f "$AGENTS_MD" ] && grep -qF "$RULE_MARKER" "$AGENTS_MD"; then
  # Delete from the ZM heading to the next top-level (##) heading or EOF.
  tmp="$(mktemp)"
  awk -v m="$RULE_MARKER" '
    index($0, m) > 0 { skip = 1 }
    skip == 1 && /^## / && index($0, m) == 0 { skip = 0 }
    skip == 0 { print }
  ' "$AGENTS_MD" > "$tmp" && mv "$tmp" "$AGENTS_MD"
  say "Migrated: removed the legacy ZM section from $AGENTS_MD (the plugin skill owns it now)"
fi

# --- next steps -------------------------------------------------------------
cat <<EOF

$(say "Done. RESTART Codex to load the plugin, then finish these one-time steps:")

  1. Authorize the watcher (ingest + briefing share one token):
      zero-memory-watcher login

  2. Authorize the MCP server in Codex (browser OAuth):
      codex   ->   /mcp   ->  authenticate 'zero-memory'

  3. TRUST the plugin hooks — Codex skips untrusted hooks until reviewed:
      codex   ->   /hooks   ->  review + trust the zero-memory hooks
      (the plugin shows in Codex Settings -> Plugins as 'zero-memory')

  SessionStart fires only on a FRESH session, so start a new one after trusting.
  Ingest stays OFF until you opt a project in via ~/.config/zero-memory/ingest.json
  (your choice, per project). The OAuth issuer must match $BASE_URL.
EOF
