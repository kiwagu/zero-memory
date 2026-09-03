#!/usr/bin/env bash
# Deploy the zero-memory (ZM) integration into a machine's GLOBAL Cursor config,
# OR package a guest bundle for a LAN machine — the Cursor sibling of
# deploy-zm-claude.sh. Run ON A CLIENT machine that already reaches the ZM
# server. Idempotent: safe to re-run; it re-points a changed URL and merges into
# existing Cursor config without dupes.
#
# It wires up, all at user scope, the pieces a Cursor consumer needs:
#   1. the `zero-memory` MCP server  -> $ZM_SERVER_URL  (~/.cursor/mcp.json),
#      asked for when unset and checked before anything is written
#   2. the `zero-memory-watcher` binary (installed to ~/.local/bin) plus the
#      `zero-memory` CURSOR PLUGIN (~/.cursor/plugins/local/zero-memory) — a
#      single managed artifact, visible on Cursor's Customize page, carrying:
#        - hooks (hooks/hooks.json): sessionStart -> brief; beforeSubmitPrompt ->
#          status; preToolUse[Grep|Glob] -> nudge; stop -> ingest;
#          preCompact -> checkpoint (captures the epoch about to be condensed;
#          capture only — Cursor's compaction event is observational)
#        - the memory-first rule (rules/zm-memory-first.mdc, always-apply)
#   3. a reminder to finish the interactive OAuth steps
#
# The MCP server is registered in ~/.cursor/mcp.json (user scope), NOT bundled in
# the plugin — a plugin-bundled server namespaces its tools (plugin-<slug>-…).
# Cursor's agent is reached through Agent Hooks (spawned processes, stdin/stdout
# JSON), mapped onto Cursor's event names + the `--client cursor` watcher flag.
#
# Two modes, chosen by whether an export dir is given:
#   bash deploy-zm-cursor.sh                     # INSTALL on this machine (default)
#   bash deploy-zm-cursor.sh /path/to/bundle-dir # PACKAGE a guest bundle into that
#                                                # dir (binary + this script +
#                                                # bundle), do NOT install here
#   ZM_SERVER_URL=https://memory.example.com/mcp bash deploy-zm-cursor.sh
set -euo pipefail

EXPORT_DIR="${1:-}"
CURSOR_DIR="$HOME/.cursor"
MCP_JSON="$CURSOR_DIR/mcp.json"
HOOKS_JSON="$CURSOR_DIR/hooks.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

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

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: 'jq' is required (JSON merge into Cursor config). Install jq." >&2
  exit 1
fi

# --- 0. locate the repo/bundle root (holds plugins/zero-memory-cursor) -------
MARKET_ROOT=""
for d in "$SCRIPT_DIR" "$SCRIPT_DIR/.." "$SCRIPT_DIR/../.."; do
  if [ -d "$d/plugins/zero-memory-cursor" ]; then
    MARKET_ROOT="$(cd "$d" && pwd)"
    break
  fi
done
if [ -z "$MARKET_ROOT" ]; then
  echo "ERROR: plugins/zero-memory-cursor not found near this script." >&2
  echo "Run from the repo, or from a bundle folder that contains it." >&2
  exit 1
fi

# --- 1. obtain the watcher binary -------------------------------------------
# Priority: bundled next to the script (guest) > build from source (dev) >
# already on PATH.
SRC_BIN=""; DIGEST=""; BINARY_SOURCE=""
if [ -f "$SCRIPT_DIR/$ZM_BIN_FILE" ]; then
  SRC_BIN="$SCRIPT_DIR/$ZM_BIN_FILE"
  DIGEST="$SCRIPT_DIR/SHA256SUMS"; [ -f "$DIGEST" ] || DIGEST="$SRC_BIN.sha256"
  BINARY_SOURCE="bundled next to script (no rebuild)"
elif [ -f "$MARKET_ROOT/scripts/build-watcher.sh" ] && command -v bun >/dev/null 2>&1; then
  BINARY_SOURCE="rebuilt from source"
  say "Building watcher binary…"
  (cd "$MARKET_ROOT" && bash scripts/build-watcher.sh >/dev/null)
  SRC_BIN="$MARKET_ROOT/dist/$ZM_BIN_FILE"
  DIGEST="$MARKET_ROOT/dist/$ZM_BIN_FILE.sha256"
elif command -v zero-memory-watcher >/dev/null 2>&1; then
  SRC_BIN="$(command -v zero-memory-watcher)"
  BINARY_SOURCE="existing on PATH (no rebuild)"
fi
if [ -z "$SRC_BIN" ]; then
  echo "ERROR: no watcher binary (none bundled, no source to build, none on PATH)." >&2
  exit 1
fi
say "Binary source: $BINARY_SOURCE"
if [ -n "$DIGEST" ] && [ -f "$DIGEST" ]; then
  if (cd "$(dirname "$SRC_BIN")" && sha256sum -c "$DIGEST" >/dev/null 2>&1); then
    say "Binary digest verified"
  else
    warn "binary digest check did not pass — continuing (rebuild on a different toolchain changes the hash)"
  fi
fi

# ============================================================================
# EXPORT MODE — an export dir was given: PACKAGE a guest bundle only, do NOT
# touch this machine's Cursor config. Publish for a LAN machine; the guest runs
# this same script with no argument to actually install.
# ============================================================================
if [ -n "$EXPORT_DIR" ]; then
  say "Export mode: staging a guest bundle — NOT installing on this machine."
  mkdir -p "$EXPORT_DIR"
  install -m 0755 "$SRC_BIN" "$EXPORT_DIR/zero-memory-watcher"
  # Carry the repo's provenance digest when the exported binary matches it;
  # otherwise regenerate a bare hash so the guest can still verify.
  repo_hash="$(awk '/^[0-9a-f]{64}[[:space:]]/{print $1; exit}' "$MARKET_ROOT/SHA256SUMS" 2>/dev/null || true)"
  export_hash="$(sha256sum "$EXPORT_DIR/zero-memory-watcher" | awk '{print $1}')"
  if [ -n "$repo_hash" ] && [ "$repo_hash" = "$export_hash" ]; then
    cp "$MARKET_ROOT/SHA256SUMS" "$EXPORT_DIR/SHA256SUMS"
  else
    (cd "$EXPORT_DIR" && sha256sum zero-memory-watcher > SHA256SUMS)
  fi
  rm -rf "$EXPORT_DIR/plugins/zero-memory-cursor"
  mkdir -p "$EXPORT_DIR/plugins"
  cp -r "$MARKET_ROOT/plugins/zero-memory-cursor" "$EXPORT_DIR/plugins/zero-memory-cursor"
  install -m 0755 "$SCRIPT_DIR/$(basename "$0")" "$EXPORT_DIR/deploy-zm-cursor.sh"
  # The installer sources this for the server address — without it the guest
  # copy would have no way to ask for, check or store one.
  for cand in "$SCRIPT_DIR/zm-server-url.sh" "$MARKET_ROOT/scripts/zm-server-url.sh"; do
    [ -f "$cand" ] && { install -m 0755 "$cand" "$EXPORT_DIR/zm-server-url.sh"; break; }
  done
  [ -f "$EXPORT_DIR/zm-server-url.sh" ] || warn "missing zm-server-url.sh — not staged."
  say "Guest bundle staged: $EXPORT_DIR"
  say "On the guest:  cd $EXPORT_DIR && bash deploy-zm-cursor.sh   (then: zero-memory-watcher login)"
  say "Summary: binary=${BINARY_SOURCE}, sha=${export_hash:0:16}…, staged=$EXPORT_DIR (NOT installed here)"
  exit 0
fi

# ============================================================================
# INSTALL MODE — no export dir: wire THIS machine's Cursor config.
# ============================================================================
mkdir -p "$CURSOR_DIR"

# --- which server? (asked, checked, then stored — see zm-server-url.sh) ------
# Install mode only: packaging a bundle above needs no server. Resolving it
# BEFORE anything is written is what keeps Cursor's registration and the
# hooks' runtime target from ending up on two different instances.
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
# The same self-contained binary that ingests transcripts serves the briefing
# hook: it is the one already-authenticated OAuth client, so a single
# `zero-memory-watcher login` covers ingest AND briefing.
mkdir -p "$HOME/.local/bin"
if [ "$SRC_BIN" != "$DEST_BIN" ]; then
  install -m 0755 "$SRC_BIN" "$DEST_BIN"
  say "Installed watcher binary -> $DEST_BIN"
else
  say "Using existing watcher binary at $DEST_BIN"
fi

# --- register the MCP server (~/.cursor/mcp.json) ---------------------------
# Cursor reads mcp.json for its MCP connections; it OAuth-authorizes the server
# itself in the browser (the token lives in Cursor's own credential store, NOT
# in this file). Deep-merge the `zero-memory` entry so any keys Cursor added are
# preserved, and only rewrite when the content actually changes — an already
# correct file is left byte-identical, so Cursor never sees a change and its
# existing authorization stands.
say "Registering MCP server 'zero-memory' -> $ZM_SERVER_URL ($MCP_JSON)"
[ -f "$MCP_JSON" ] || printf '{}\n' > "$MCP_JSON"
new_mcp="$(jq --arg url "$ZM_SERVER_URL" '
  .mcpServers["zero-memory"] = ((.mcpServers["zero-memory"] // {}) + {url: $url})
' "$MCP_JSON")"
if [ "$new_mcp" != "$(cat "$MCP_JSON")" ]; then
  printf '%s\n' "$new_mcp" > "$MCP_JSON"
  say "mcp.json updated"
else
  say "mcp.json already registers zero-memory -> $ZM_SERVER_URL — left untouched"
fi

# --- install the plugin (~/.cursor/plugins/local/zero-memory) ---------------
# Cursor auto-discovers hooks (hooks/hooks.json) and rules (rules/*.mdc) from a
# plugin dropped in ~/.cursor/plugins/local — so we ship ONE managed artifact,
# visible/toggleable on Cursor's Customize page, instead of hand-editing
# ~/.cursor/hooks.json. There is no plugin-root path variable, so the hook
# commands are rewritten to the ABSOLUTE installed-binary path.
PLUGIN_SRC="$MARKET_ROOT/plugins/zero-memory-cursor"
PLUGIN_DEST="$CURSOR_DIR/plugins/local/zero-memory"
say "Installing plugin -> $PLUGIN_DEST"
rm -rf "$PLUGIN_DEST"
mkdir -p "$(dirname "$PLUGIN_DEST")"
cp -r "$PLUGIN_SRC" "$PLUGIN_DEST"
tmp="$(mktemp)"
jq --arg bin "$DEST_BIN" '
  .hooks |= map_values(map(.command |= sub("^zero-memory-watcher"; $bin)))
' "$PLUGIN_DEST/hooks/hooks.json" > "$tmp" && mv "$tmp" "$PLUGIN_DEST/hooks/hooks.json"

# --- migrate off the old direct ~/.cursor/hooks.json wiring -----------------
# Earlier versions wrote the hooks straight into ~/.cursor/hooks.json; the plugin
# owns them now. Strip our `--client cursor` entries (and any event array they
# empty) so they never fire twice; unrelated hooks are preserved.
if [ -f "$HOOKS_JSON" ]; then
  new_hooks="$(jq '
    if .hooks then
      .hooks |= (map_values(map(select((.command // "") | contains("--client cursor") | not)))
        | with_entries(select(.value | length > 0)))
    else . end
  ' "$HOOKS_JSON")"
  # If nothing but our own leftover remains (empty hooks + only version/hooks
  # keys), delete the file so no vestigial config lingers. Otherwise keep it
  # (foreign hooks present) and rewrite only when it actually changed.
  vestigial="$(printf '%s' "$new_hooks" | jq -r '
    if ((.hooks // {}) == {}) and ((keys - ["version", "hooks"]) | length == 0)
    then "yes" else "no" end')"
  if [ "$vestigial" = "yes" ]; then
    rm -f "$HOOKS_JSON"
    say "Removed the now-empty legacy $HOOKS_JSON (the plugin owns the hooks)"
  elif [ "$new_hooks" != "$(cat "$HOOKS_JSON")" ]; then
    printf '%s\n' "$new_hooks" > "$HOOKS_JSON"
    say "Stripped legacy direct hooks from $HOOKS_JSON (the plugin owns them now)"
  fi
fi

# --- next steps (interactive OAuth, both clients) ---------------------------
cat <<EOF

$(say "Done. Two one-time authorizations remain (both OAuth, can't be scripted):")

  1. Cursor as an MCP client (recall / build_context / remember tools):
      open Cursor -> Settings -> MCP -> 'zero-memory' -> authenticate (browser)

  2. The watcher hooks (ingest + briefing share one token):
      zero-memory-watcher login

  The OAuth issuer must match exactly — this client talks to $BASE_URL, which
  is why the server's ZM_PUBLIC_URL is set to that same URL.

  Restart Cursor so it loads the plugin + ~/.cursor/mcp.json. The plugin then
  shows on the Customize page as 'zero-memory' (hooks + the memory-first rule).

  Ingest stays OFF until you opt a project in via ~/.config/zero-memory/ingest.json
  (your choice, per project) — the plugin does not enable capture on its own.
EOF
