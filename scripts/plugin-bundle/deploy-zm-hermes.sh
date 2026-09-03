#!/usr/bin/env bash
# Deploy the zero-memory (ZM) integration into a machine's Hermes profile — the
# Hermes sibling of deploy-zm-claude.sh / deploy-zm-codex.sh / deploy-zm-cursor.sh.
# Run ON A CLIENT machine that already reaches the ZM server. Idempotent.
#
# Hermes is the fourth client adapter. Unlike the other three its plugin is
# PYTHON (plugin.yaml + register(ctx)) rather than a JSON hook manifest, and it
# is enabled by name in config.yaml rather than by an editor command — Hermes
# plugins are opt-in by design, so an installed-but-unlisted plugin never runs.
# This script wires, all at profile scope:
#   1. the watcher binary (~/.local/bin) — the shared, already-authenticated
#      OAuth client every adapter's hooks exec
#   2. the `zero-memory` plugin, copied into <profile>/plugins/ and added to
#      plugins.enabled, whose hooks are:
#        on_session_start -> open the mirror + warm the briefing cache
#        pre_llm_call     -> session/task briefing + health warning (injects)
#        post_llm_call    -> mirror the turn + ingest the delta (opt-in)
#        post_tool_call   -> mirror recall results (the judge's channel)
#        on_pre_compress  -> capture the epoch about to be compressed
#        on_session_end   -> session value receipt
#   3. the `zero-memory` MCP server under mcp_servers in config.yaml (NOT in
#      the plugin — Hermes' config-driven MCP keeps the plain tool names)
#
# Two modes, chosen by whether an export dir is given:
#   bash deploy-zm-hermes.sh                       # INSTALL on this machine
#   bash deploy-zm-hermes.sh /path/to/bundle-dir   # PACKAGE a guest bundle
#   ZM_SERVER_URL=https://memory.example.com/mcp bash deploy-zm-hermes.sh
#   HERMES_PROFILE=me-coder bash deploy-zm-hermes.sh   # a non-default profile
set -euo pipefail

# --- the REAL home, when HOME is a Hermes profile sandbox -------------------
# A running Hermes session exports HOME=<HERMES_HOME>/<profile>/home. This
# installer is most naturally run FROM such a session ("set up memory for
# Hermes"), and every path it touches — the watcher binary in ~/.local/bin, the
# stored server URL in ~/.config/zero-memory, the OAuth token the watcher later
# reads — would then land in that sandbox, invisible to every other client and
# to the watcher itself.
#
# The correction is deliberately NARROW: only a path that LOOKS like the
# sandbox (…/profiles/<name>/home, or Hermes' own HERMES_REAL_HOME hint) is
# overridden. An earlier version simply compared HOME against the password
# database and replaced it whenever they differed — which silently hijacked
# every legitimate HOME override (a test into a scratch home, a CI runner, a
# container, a multi-user install) and wrote to the invoking user's real home
# instead. A deliberate HOME must be honoured; only the sandbox is escaped.
if [ -n "${HERMES_REAL_HOME:-}" ] && [ "$HERMES_REAL_HOME" != "$HOME" ]; then
  printf '\033[1;36m==>\033[0m %s\n' \
    "HOME is a Hermes profile sandbox — using the real home: $HERMES_REAL_HOME"
  HOME="$HERMES_REAL_HOME"
  export HOME
elif printf '%s' "$HOME" | grep -qE '/profiles/[^/]+/home/?$'; then
  _real_home="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
  if [ -n "$_real_home" ] && [ "$_real_home" != "$HOME" ]; then
    printf '\033[1;36m==>\033[0m %s\n' \
      "HOME is a Hermes profile sandbox — using the real home: $_real_home"
    HOME="$_real_home"
    export HOME
  fi
fi

EXPORT_DIR="${1:-}"
HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"
PROFILE="${HERMES_PROFILE:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

# --- 0a. is this bundle even for this machine? ------------------------------
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

PLUGIN_SRC="${MARKET_ROOT:-/nonexistent}/plugins/zero-memory-hermes"
[ -d "$PLUGIN_SRC" ] || PLUGIN_SRC="$SCRIPT_DIR/plugins/zero-memory-hermes"

# ============================================================================
# EXPORT MODE — stage a guest bundle (binary + digest + plugin + this script).
# ============================================================================
if [ -n "$EXPORT_DIR" ]; then
  say "Export mode: staging a guest bundle — NOT installing on this machine."
  mkdir -p "$EXPORT_DIR"
  install -m 0755 "$SRC_BIN" "$EXPORT_DIR/zero-memory-watcher"
  repo_hash="$(awk '/^[0-9a-f]{64}[[:space:]]/{print $1; exit}' "${MARKET_ROOT:-/nonexistent}/SHA256SUMS" 2>/dev/null || true)"
  export_hash="$(sha256sum "$EXPORT_DIR/zero-memory-watcher" | awk '{print $1}')"
  if [ -n "$repo_hash" ] && [ "$repo_hash" = "$export_hash" ]; then
    cp "${MARKET_ROOT}/SHA256SUMS" "$EXPORT_DIR/SHA256SUMS"
  else
    (cd "$EXPORT_DIR" && sha256sum zero-memory-watcher > SHA256SUMS)
  fi
  install -m 0755 "$SCRIPT_DIR/$(basename "$0")" "$EXPORT_DIR/deploy-zm-hermes.sh"
  for cand in "$SCRIPT_DIR/zm-server-url.sh" "${MARKET_ROOT:-/nonexistent}/scripts/zm-server-url.sh"; do
    [ -f "$cand" ] && { install -m 0755 "$cand" "$EXPORT_DIR/zm-server-url.sh"; break; }
  done
  [ -f "$EXPORT_DIR/zm-server-url.sh" ] || warn "missing zm-server-url.sh — not staged."
  if [ -d "$PLUGIN_SRC" ]; then
    rm -rf "$EXPORT_DIR/plugins/zero-memory-hermes"
    mkdir -p "$EXPORT_DIR/plugins"
    cp -r "$PLUGIN_SRC" "$EXPORT_DIR/plugins/zero-memory-hermes"
  fi
  say "Guest bundle staged: $EXPORT_DIR"
  say "On the guest:  cd $EXPORT_DIR && bash deploy-zm-hermes.sh   (then: zero-memory-watcher login)"
  exit 0
fi

# ============================================================================
# INSTALL MODE — wire THIS machine's Hermes profile.
# ============================================================================
[ -d "$HERMES_ROOT" ] || { echo "ERROR: no Hermes home at $HERMES_ROOT (set HERMES_HOME)." >&2; exit 1; }

# --- which profile? ---------------------------------------------------------
# Hermes keeps each profile's config, plugins and sessions apart, so installing
# into the wrong one is a silent no-op: everything reports success and no hook
# ever fires. Two layouts have to be told apart, and the difference is not
# cosmetic — HERMES_HOME means different things in each:
#
#   * a ROOT   (~/.hermes) holding profiles/<name>/, and
#   * a PROFILE directory itself — which is what a running Hermes session
#     exports (measured: HERMES_HOME=~/.hermes/profiles/me-coder), so an
#     installer run from inside a session sees the profile, not the root.
#
# Appending the profile name to a path that already ends in it is exactly the
# failure this resolves: it produced .../profiles/me-coder/profiles/me-coder.
if [ -d "$HERMES_ROOT/profiles" ]; then
  # A root layout. Pick the named profile, or the only one there is.
  if [ -z "$PROFILE" ]; then
    count="$(find "$HERMES_ROOT/profiles" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
    if [ "$count" = "1" ]; then
      PROFILE="$(basename "$(find "$HERMES_ROOT/profiles" -mindepth 1 -maxdepth 1 -type d)")"
    elif [ "$count" = "0" ]; then
      echo "ERROR: no profiles under $HERMES_ROOT/profiles." >&2
      exit 1
    else
      echo "ERROR: $count Hermes profiles found. Name one: HERMES_PROFILE=<name> bash $(basename "$0")" >&2
      find "$HERMES_ROOT/profiles" -mindepth 1 -maxdepth 1 -type d -printf '  %f\n' >&2
      exit 1
    fi
  fi
  PROFILE_DIR="$HERMES_ROOT/profiles/$PROFILE"
  [ -d "$PROFILE_DIR" ] || { echo "ERROR: no such Hermes profile: $PROFILE_DIR" >&2; exit 1; }
  say "Hermes profile: $PROFILE ($PROFILE_DIR)"
elif [ -f "$HERMES_ROOT/config.yaml" ] || [ -d "$HERMES_ROOT/plugins" ]; then
  # HERMES_HOME already IS the profile (or a single-profile home). A named
  # profile is honored only when it agrees with the path — silently installing
  # somewhere other than where the user pointed is worse than refusing.
  PROFILE_DIR="$HERMES_ROOT"
  actual="$(basename "$PROFILE_DIR")"
  if [ -n "$PROFILE" ] && [ "$PROFILE" != "$actual" ]; then
    echo "ERROR: HERMES_HOME is the profile '$actual', but HERMES_PROFILE=$PROFILE was given." >&2
    echo "       Point HERMES_HOME at the Hermes ROOT (~/.hermes) to choose a profile by name." >&2
    exit 1
  fi
  say "Hermes profile: $actual ($PROFILE_DIR)"
else
  echo "ERROR: $HERMES_ROOT looks like neither a Hermes root nor a profile." >&2
  exit 1
fi
CONFIG_YAML="$PROFILE_DIR/config.yaml"
PLUGIN_DEST="$PROFILE_DIR/plugins/zero-memory"

# --- which server? (asked, checked, then stored — see zm-server-url.sh) ------
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
mkdir -p "$HOME/.local/bin"
if [ "$SRC_BIN" != "$DEST_BIN" ]; then
  install -m 0755 "$SRC_BIN" "$DEST_BIN"; say "Installed watcher binary -> $DEST_BIN"
else
  say "Using existing watcher binary at $DEST_BIN"
fi

# --- install the plugin ------------------------------------------------------
# Copied rather than symlinked: `hermes plugins` treats the directory as the
# install tree, and a symlink into a git checkout would make a `git checkout`
# silently change what the agent loads.
if [ -d "$PLUGIN_SRC" ]; then
  mkdir -p "$(dirname "$PLUGIN_DEST")"
  rm -rf "$PLUGIN_DEST"
  cp -r "$PLUGIN_SRC" "$PLUGIN_DEST"
  # Runtime state (the transcript mirror) never lives in the install tree —
  # this directory is deleted on every update, which is why mirror.py writes
  # under ~/.local/state/zero-memory instead.
  say "Installed plugin -> $PLUGIN_DEST"
else
  echo "ERROR: plugin source not found (looked in $PLUGIN_SRC)." >&2
  exit 1
fi

# --- wire config.yaml: enable the plugin + register the MCP server -----------
# Hermes plugins are opt-in: discovery finds the directory, but nothing loads
# until the name is in plugins.enabled. Both edits are idempotent and are made
# with Python's YAML (already required by Hermes itself) rather than by text
# munging, so an existing config keeps its other keys intact.
python3 - "$CONFIG_YAML" "$ZM_SERVER_URL" <<'PY'
import sys
from pathlib import Path

import yaml

config_path, server_url = Path(sys.argv[1]), sys.argv[2]
config = {}
if config_path.exists():
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}

plugins = config.setdefault("plugins", {})
enabled = plugins.setdefault("enabled", [])
if "zero-memory" not in enabled:
    enabled.append("zero-memory")
    print("  + plugins.enabled: zero-memory")

# Settings are only SEEDED, never overwritten: capture is the user's consent
# decision, and re-running an installer must not silently turn it on.
entries = plugins.setdefault("entries", {})
settings = entries.setdefault("zero-memory", {}).setdefault("settings", {})
settings.setdefault("capture", False)

servers = config.setdefault("mcp_servers", {})
existing = servers.get("zero-memory")
if not isinstance(existing, dict) or existing.get("url") != server_url:
    servers["zero-memory"] = {"url": server_url, "auth": "oauth", "enabled": True}
    print(f"  + mcp_servers.zero-memory -> {server_url}")

config_path.parent.mkdir(parents=True, exist_ok=True)
config_path.write_text(
    yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding="utf-8"
)
print(f"  wrote {config_path}")
PY
say "Wired config.yaml (plugin enabled + MCP server registered)"

# --- next steps -------------------------------------------------------------
cat <<EOF

$(say "Done. RESTART Hermes to load the plugin, then finish these one-time steps:")

  1. Authorize the watcher (ingest + briefing share one token):
      zero-memory-watcher login

  2. Authorize the MCP server in Hermes (browser OAuth):
      hermes  ->  /mcp   (or: hermes mcp auth zero-memory)

  3. Check the wiring from inside a session:
      /zm status        which server this machine talks to
      /plugins          should list 'zero-memory'

  Transcript capture is OFF by default — nothing is written to disk. Turn it on
  per machine in $CONFIG_YAML:
      plugins.entries.zero-memory.settings.capture: true
  and opt each project in via ~/.config/zero-memory/ingest.json (your choice,
  per project). The OAuth issuer must match $BASE_URL.
EOF
