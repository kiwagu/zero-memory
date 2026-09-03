#!/usr/bin/env bash
# deploy-zm-claude-remote-host.sh
#
# Re-home the zero-memory Claude Code plugin bundle OFF an unreliable source
# (typically a network mount — the classic failure is NFS "stale file handle")
# ONTO local disk, then reinstall it from there. Run this ON the machine that
# uses the plugin (the consumer), not on the file server.
#
# What it does, idempotently:
#   1. uninstall the currently-installed plugin + remove its marketplace
#   2. purge the stale plugin cache for that marketplace
#   3. copy the plugin bundle PLUGIN_BUNDLE_DIR -> LOCAL_DEST (deref symlinks)
#   4. reinstall from LOCAL_DEST by delegating to the bundle's deploy-zm-claude.sh
#      (installs the watcher binary to ~/.local/bin, re-adds the marketplace
#      from the LOCAL path, installs the plugin at user scope)
#   5. (re)create the plugin/bin symlink so the hook commands resolve
#   6. verify
#
# Usage:
#   bash deploy-zm-claude-remote-host.sh [bundle-dir]
#
# The bundle source (a dir holding .claude-plugin/marketplace.json) resolves
# in this order:
#   1. the [bundle-dir] argument
#   2. $PLUGIN_BUNDLE_DIR
#   3. the directory this script ships in (it is staged into every bundle)
#   4. a single bundle found a few levels below this script's directory
#
# Other overrides via env:
#   LOCAL_DEST   local disk destination for the bundle
#   MARKETPLACE  marketplace name (must match marketplace.json "name")
#   PLUGIN       installed plugin name = the id component (plugin.json "name")
#   PLUGIN_DIR   the bundle folder under plugins/ (may differ from PLUGIN)
#   WATCHER_BIN  installed watcher binary the plugin/bin symlink points at
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_DEST="${LOCAL_DEST:-$HOME/.local/share/zm-bundle}"
MARKETPLACE="${MARKETPLACE:-zero-memory}"
# The plugin NAME (id component) and its bundle FOLDER differ: the folder is
# named for uniformity with the other clients, the name stays short for /<name>:
# slash commands. Keep them as two knobs.
PLUGIN="${PLUGIN:-zm}"
PLUGIN_DIR="${PLUGIN_DIR:-zero-memory-claude}"
PLUGIN_ID="${PLUGIN}@${MARKETPLACE}"
WATCHER_BIN="${WATCHER_BIN:-$HOME/.local/bin/zero-memory-watcher}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- resolve the claude CLI even if ~/.local/bin is not on PATH ---------------
CLAUDE="$(command -v claude || true)"
[ -z "$CLAUDE" ] && [ -x "$HOME/.local/bin/claude" ] && CLAUDE="$HOME/.local/bin/claude"
[ -z "$CLAUDE" ] && die "'claude' CLI not found (looked on PATH and in ~/.local/bin)."
say "Using claude CLI: $CLAUDE"

# --- resolve the bundle source (see the order in the header) ------------------
# Accept an optional [bundle-dir] positional; ignore flag-style args so a stray
# `--with-ingest` is not mistaken for the bundle dir — this script always
# installs with ingest wiring (it passes --with-ingest to the bundled deployer).
BUNDLE_ARG=""
for a in "$@"; do
  case "$a" in
    -*) warn "ignoring flag '$a' — this script always installs with ingest wiring." ;;
    *)  BUNDLE_ARG="$a" ;;
  esac
done
PLUGIN_BUNDLE_DIR="${BUNDLE_ARG:-${PLUGIN_BUNDLE_DIR:-}}"
if [ -z "$PLUGIN_BUNDLE_DIR" ]; then
  if [ -f "$SCRIPT_DIR/.claude-plugin/marketplace.json" ]; then
    PLUGIN_BUNDLE_DIR="$SCRIPT_DIR"
  else
    mapfile -t hits < <(find "$SCRIPT_DIR" -maxdepth 4 \
      -path '*/.claude-plugin/marketplace.json' 2>/dev/null)
    if [ "${#hits[@]}" -eq 1 ]; then
      PLUGIN_BUNDLE_DIR="$(cd "$(dirname "${hits[0]}")/.." && pwd)"
    elif [ "${#hits[@]}" -gt 1 ]; then
      die "several bundles under $SCRIPT_DIR — pass [bundle-dir] or set PLUGIN_BUNDLE_DIR."
    fi
  fi
fi
[ -n "$PLUGIN_BUNDLE_DIR" ] \
  || die "no plugin bundle found — pass [bundle-dir] or set PLUGIN_BUNDLE_DIR."
# canonicalize: the path is recorded as the update origin, so it must be
# absolute and stable, not relative to wherever the script was invoked.
PLUGIN_BUNDLE_DIR="$(cd "$PLUGIN_BUNDLE_DIR" 2>/dev/null && pwd)" \
  || die "bundle dir not accessible: check the path / mount."

# --- 0. sanity: the source is a valid, readable plugin bundle -----------------
[ -f "$PLUGIN_BUNDLE_DIR/.claude-plugin/marketplace.json" ] \
  || die "no .claude-plugin/marketplace.json in bundle: $PLUGIN_BUNDLE_DIR"
[ -d "$PLUGIN_BUNDLE_DIR/plugins/$PLUGIN_DIR" ] \
  || die "no plugins/$PLUGIN_DIR in bundle: $PLUGIN_BUNDLE_DIR"
say "Bundle source OK: $PLUGIN_BUNDLE_DIR"

# --- 1. uninstall the plugin + remove the old marketplace (best-effort) -------
say "Removing existing install of $PLUGIN_ID (if any)…"
"$CLAUDE" plugin uninstall "$PLUGIN_ID" 2>/dev/null || warn "plugin not installed (ok)"
"$CLAUDE" plugin marketplace remove "$MARKETPLACE" 2>/dev/null || warn "marketplace not registered (ok)"

# --- 2. purge stale plugin cache for this marketplace ------------------------
CACHE="$HOME/.claude/plugins/cache/$MARKETPLACE"
if [ -d "$CACHE" ]; then
  say "Purging stale plugin cache: $CACHE"
  rm -rf "$CACHE"
fi

# --- 3. copy the bundle source -> local (dereference symlinks) ---------------
say "Copying bundle: $PLUGIN_BUNDLE_DIR -> $LOCAL_DEST"
rm -rf "$LOCAL_DEST"
mkdir -p "$(dirname "$LOCAL_DEST")"
# -RL: recursive + dereference symlinks, so nothing points back at the
# unreliable source. Deliberately NOT -a/--preserve=all: network-mount
# ACLs/xattrs can't be replayed onto the local fs ("Operation not supported").
# Exec bits that matter are (re)set later by the bundled deployer / install.
cp -RL "$PLUGIN_BUNDLE_DIR" "$LOCAL_DEST"

# --- 4. reinstall from the LOCAL copy via the bundled deployer ----------------
DEPLOYER="$LOCAL_DEST/deploy-zm-claude.sh"
if [ -f "$DEPLOYER" ]; then
  say "Delegating install to bundled deployer (from local copy)…"
  # runs from LOCAL_DEST => marketplace is (re)added pointing at local disk.
  # Prepend the resolved claude dir to PATH: the bundled deployer does its own
  # `command -v claude`, which fails if ~/.local/bin is not on PATH.
  # ZM_UPDATE_SOURCE: updates come from the ORIGINAL bundle source, not the
  # local copy we just made — so the deployer records the true origin for the
  # watcher's update check.
  ( cd "$LOCAL_DEST" && PATH="$(dirname "$CLAUDE"):$PATH" \
      ZM_UPDATE_SOURCE="$PLUGIN_BUNDLE_DIR" bash "$DEPLOYER" --with-ingest )
else
  warn "No bundled deploy-zm-claude.sh — installing directly."
  "$CLAUDE" plugin marketplace add "$LOCAL_DEST"
  "$CLAUDE" plugin install "$PLUGIN_ID" --scope user
  # Record the update origin ourselves — normally the bundled deployer does it.
  ORIGIN_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/zero-memory/plugin-origin.json"
  INSTALLED_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$LOCAL_DEST/plugins/$PLUGIN_DIR/.claude-plugin/plugin.json" 2>/dev/null | head -n1)"
  mkdir -p "$(dirname "$ORIGIN_FILE")"
  printf '{"source":"%s","source_manifest":"%s","installed_version":"%s","update_command":"%s","installed_at":"%s"}\n' \
    "$PLUGIN_BUNDLE_DIR" \
    "$PLUGIN_BUNDLE_DIR/plugins/$PLUGIN_DIR/.claude-plugin/plugin.json" \
    "${INSTALLED_VERSION:-unknown}" \
    "bash $PLUGIN_BUNDLE_DIR/deploy-zm-claude-remote-host.sh" \
    "$(date -Is)" > "$ORIGIN_FILE"
  say "Recorded update source: $PLUGIN_BUNDLE_DIR (installed v${INSTALLED_VERSION:-unknown})"
fi

# --- 5. (re)create the plugin/bin symlink for the hook commands ---------------
# The plugin hooks call ${CLAUDE_PLUGIN_ROOT}/bin/zero-memory-watcher; the
# watcher is installed to ~/.local/bin, which hook subprocesses may not have on
# PATH. The bundled deployer creates this symlink itself — this repeat covers
# the fallback branch above (direct install without the deployer).
BINDIR="$LOCAL_DEST/plugins/$PLUGIN_DIR/bin"
if [ -x "$WATCHER_BIN" ]; then
  mkdir -p "$BINDIR"
  ln -sfn "$WATCHER_BIN" "$BINDIR/zero-memory-watcher"
  say "Linked $BINDIR/zero-memory-watcher -> $WATCHER_BIN"
else
  warn "Watcher binary not found at $WATCHER_BIN — skipped plugin/bin symlink."
  warn "The deployer should have installed it; re-run or check ~/.local/bin."
fi

# --- 6. verify ----------------------------------------------------------------
say "Verify — installed plugins:"
"$CLAUDE" plugin list 2>&1 | sed -n '1,12p' || true
say "Verify — marketplaces (installLocation should now be LOCAL):"
"$CLAUDE" plugin marketplace list 2>&1 | sed -n '1,20p' || true

cat <<EOF

$(say "Done. Plugin re-homed to local disk: $LOCAL_DEST")

  Next:
    • Fully reload Claude Code so hooks re-read config:
        VSCode → "Developer: Reload Window", then start a NEW conversation.
    • In-session, confirm hooks are registered:  /hooks   (look for Stop -> zero-memory-watcher ingest)
    • Watch the watchdog:  zero-memory-watcher logs -f
EOF
