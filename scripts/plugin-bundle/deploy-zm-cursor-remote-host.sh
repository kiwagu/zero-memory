#!/usr/bin/env bash
# deploy-zm-cursor-remote-host.sh
#
# Re-home the zero-memory guest bundle OFF an unreliable source (typically a
# network mount — the classic failure is NFS "stale file handle") ONTO local
# disk, then install the Cursor integration from there. Run this ON the machine
# that uses Cursor (the consumer). The Cursor sibling of
# deploy-zm-claude-remote-host.sh.
#
# Why re-home for Cursor: deploy-zm-cursor.sh copies the plugin into
# ~/.cursor/plugins/local and writes ~/.cursor config, so the install leaves NO
# persistent pointer at the mount — but reading the ~90 MB binary + plugin
# straight off a flaky share DURING install is what fails. Copying to local disk
# first makes the install read from stable storage.
#
# Usage:
#   bash deploy-zm-cursor-remote-host.sh [bundle-dir]
#
# The bundle source resolves like the other re-home helpers:
#   1. the [bundle-dir] argument   2. $PLUGIN_BUNDLE_DIR
#   3. the directory this script ships in
#   4. a single bundle found a few levels below this script's directory
# Env: LOCAL_DEST (local copy destination), ZM_SERVER_URL (MCP endpoint; forwarded to
# the installer).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_DEST="${LOCAL_DEST:-$HOME/.local/share/zm-bundle}"
CLIENT="Cursor"
INSTALLER="deploy-zm-cursor.sh"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- resolve the bundle source (ignore flag-style args) ----------------------
BUNDLE_ARG=""
for a in "$@"; do
  case "$a" in
    -*) warn "ignoring flag '$a' — this re-home helper takes only an optional [bundle-dir]." ;;
    *)  BUNDLE_ARG="$a" ;;
  esac
done
PLUGIN_BUNDLE_DIR="${BUNDLE_ARG:-${PLUGIN_BUNDLE_DIR:-}}"
if [ -z "$PLUGIN_BUNDLE_DIR" ]; then
  if [ -f "$SCRIPT_DIR/$INSTALLER" ]; then
    PLUGIN_BUNDLE_DIR="$SCRIPT_DIR"
  else
    mapfile -t hits < <(find "$SCRIPT_DIR" -maxdepth 4 -name "$INSTALLER" 2>/dev/null)
    if [ "${#hits[@]}" -eq 1 ]; then
      PLUGIN_BUNDLE_DIR="$(cd "$(dirname "${hits[0]}")" && pwd)"
    elif [ "${#hits[@]}" -gt 1 ]; then
      die "several bundles under $SCRIPT_DIR — pass [bundle-dir] or set PLUGIN_BUNDLE_DIR."
    fi
  fi
fi
[ -n "$PLUGIN_BUNDLE_DIR" ] \
  || die "no bundle found — pass [bundle-dir] or set PLUGIN_BUNDLE_DIR."
# canonicalize: absolute + stable, not relative to the invocation dir.
PLUGIN_BUNDLE_DIR="$(cd "$PLUGIN_BUNDLE_DIR" 2>/dev/null && pwd)" \
  || die "bundle dir not accessible: check the path / mount."
[ -f "$PLUGIN_BUNDLE_DIR/$INSTALLER" ] \
  || die "no $INSTALLER in bundle: $PLUGIN_BUNDLE_DIR"
[ -f "$PLUGIN_BUNDLE_DIR/zero-memory-watcher" ] \
  || die "no zero-memory-watcher in bundle: $PLUGIN_BUNDLE_DIR"
say "Bundle source OK: $PLUGIN_BUNDLE_DIR"

# --- copy the bundle -> local disk (dereference symlinks) --------------------
# -RL: recursive + dereference, so nothing points back at the unreliable source.
say "Copying bundle: $PLUGIN_BUNDLE_DIR -> $LOCAL_DEST"
rm -rf "$LOCAL_DEST"
mkdir -p "$(dirname "$LOCAL_DEST")"
cp -RL "$PLUGIN_BUNDLE_DIR" "$LOCAL_DEST"

# --- install from the LOCAL copy ---------------------------------------------
say "Installing the $CLIENT integration from the local copy…"
( cd "$LOCAL_DEST" && bash "./$INSTALLER" )

cat <<EOF

$(say "Done. $CLIENT integration installed from local disk: $LOCAL_DEST")

  Next:
    • Finish the one-time OAuth:  zero-memory-watcher login
    • Fully restart Cursor so it loads the plugin + hooks.
EOF
