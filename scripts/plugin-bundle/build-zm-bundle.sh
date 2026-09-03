#!/usr/bin/env bash
# build-zm-bundle.sh
#
# Build the MULTI-CLIENT zero-memory guest bundle: the shared watcher binary +
# all client plugin folders + every per-client installer + the re-home helpers +
# a self-describing README/VERSION, staged into a directory for others to
# consume over a LAN share or a copied folder. Client-NEUTRAL by design — no
# single client's installer owns bundle-building (the symmetry the per-client
# deploy-zm-<client>.sh scripts depend on).
#
# It does NOT install anything on this machine and does NOT touch this host's
# Claude Code / Codex / Cursor config — it only stages files. A guest then runs
# their client's installer from the bundle (see the generated README.md).
#
# The bundle is PLATFORM-SPECIFIC (it carries a compiled binary), so it names
# its platform in three agreeing places — the archive file name, the `target`
# field of bundle.json, and the check every installer runs before touching a
# machine. Builds for other platforms are meant to sit BESIDE this one on a
# release page; see scripts/zm-platform.sh for the supported list.
#
# Usage:
#   bash build-zm-bundle.sh <export-dir>                    # stage a folder
#   bash build-zm-bundle.sh <export-dir> --tar <dir>        # …and pack .tar.gz
#   bash build-zm-bundle.sh <export-dir> --zip <dir>        # …and pack .zip
#   bash build-zm-bundle.sh <export-dir> --target <target>  # …for another platform
#
# Both packing flags may be given at once: they pack the SAME staged folder, so
# the two archives of one release are byte-identical in content. --target
# cross-compiles the binary (see scripts/zm-platform.sh for the supported list),
# which is how a Linux runner produces the Windows bundle.
#
# Env overrides:
#   ZM_SERVER_URL   not used here — an exported bundle is server-agnostic; each
#                   guest's installer asks for (or is given) its own address
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MARKETPLACE_NAME="zero-memory"
PLUGIN_ID="zm@${MARKETPLACE_NAME}"

EXPORT_DIR="${1:-}"
[ -n "$EXPORT_DIR" ] || { echo "ERROR: usage: build-zm-bundle.sh <export-dir> [--tar <dir>] [--zip <dir>] [--target <target>]" >&2; exit 1; }
shift
ZIP_DIR=""
TAR_DIR=""
REQUESTED_TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --zip)
      shift
      ZIP_DIR="${1:-}"
      [ -n "$ZIP_DIR" ] || { echo "ERROR: --zip needs a destination directory" >&2; exit 1; }
      ;;
    --zip=*) ZIP_DIR="${1#*=}" ;;
    --tar)
      shift
      TAR_DIR="${1:-}"
      [ -n "$TAR_DIR" ] || { echo "ERROR: --tar needs a destination directory" >&2; exit 1; }
      ;;
    --tar=*) TAR_DIR="${1#*=}" ;;
    --target)
      shift
      REQUESTED_TARGET="${1:-}"
      [ -n "$REQUESTED_TARGET" ] || { echo "ERROR: --target needs a platform" >&2; exit 1; }
      ;;
    --target=*) REQUESTED_TARGET="${1#*=}" ;;
    *) echo "ERROR: unknown argument '$1'" >&2; exit 1 ;;
  esac
  shift
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 0. locate the marketplace/repo root (holds .claude-plugin + plugins) -----
MARKET_ROOT=""
for d in "$SCRIPT_DIR" "$SCRIPT_DIR/.." "$SCRIPT_DIR/../.."; do
  if [ -f "$d/.claude-plugin/marketplace.json" ]; then
    MARKET_ROOT="$(cd "$d" && pwd)"
    break
  fi
done
[ -n "$MARKET_ROOT" ] || die ".claude-plugin/marketplace.json not found near this script — run from the repo."
say "Marketplace root: $MARKET_ROOT"

# --- 0b. which platform is this bundle for? ---------------------------------
# The binary is compiled, so the bundle is only valid on one platform. It is
# named here, once, and every later step (file name, manifest, installer guard)
# reads this value instead of re-deriving it.
for cand in "$MARKET_ROOT/scripts/zm-platform.sh" "$SCRIPT_DIR/../zm-platform.sh"; do
  # shellcheck source=scripts/zm-platform.sh
  [ -f "$cand" ] && { . "$cand"; break; }
done
command -v zm_host_target >/dev/null 2>&1 \
  || die "zm-platform.sh not found next to this script."
HOST_TARGET="$(zm_host_target)"
BUNDLE_TARGET="${REQUESTED_TARGET:-$HOST_TARGET}"
zm_target_supported "$BUNDLE_TARGET" \
  || die "no bundle is produced for $BUNDLE_TARGET yet (see scripts/zm-platform.sh)."
BIN_FILE="$(zm_binary_file "$BUNDLE_TARGET")"
if [ "$BUNDLE_TARGET" = "$HOST_TARGET" ]; then
  say "Bundle platform: $BUNDLE_TARGET"
else
  say "Bundle platform: $BUNDLE_TARGET (cross-built on $HOST_TARGET)"
fi

# --- 1. obtain + verify the watcher binary ----------------------------------
# A build host: rebuild from source (canonical digest) if possible, else fall
# back to a binary already on PATH so a source-less checkout can still stage.
SRC_BIN=""; DIGEST=""; BINARY_SOURCE=""
if [ -f "$MARKET_ROOT/scripts/build-watcher.sh" ] && command -v bun >/dev/null 2>&1; then
  BINARY_SOURCE="rebuilt from source"
  say "Binary source: $BINARY_SOURCE — building…"
  # A cross build names its bun triple; build-watcher.sh appends .exe itself for
  # a Windows target and leaves the repo's committed digest alone, since that
  # digest attests the canonical host build and nothing else.
  if [ "$BUNDLE_TARGET" = "$HOST_TARGET" ]; then
    (cd "$MARKET_ROOT" && bash scripts/build-watcher.sh >/dev/null)
  else
    (cd "$MARKET_ROOT" && TARGET="$(zm__bun_target "$BUNDLE_TARGET")" \
      bash scripts/build-watcher.sh >/dev/null)
  fi
  SRC_BIN="$MARKET_ROOT/dist/$BIN_FILE"
  DIGEST="$MARKET_ROOT/dist/$BIN_FILE.sha256"
elif [ "$BUNDLE_TARGET" = "$HOST_TARGET" ] && command -v zero-memory-watcher >/dev/null 2>&1; then
  SRC_BIN="$(command -v zero-memory-watcher)"
  BINARY_SOURCE="existing on PATH (no rebuild)"
  say "Binary source: $BINARY_SOURCE"
fi
[ -n "$SRC_BIN" ] || die "no watcher binary for $BUNDLE_TARGET (no source to build, none on PATH)."
if [ -f "$DIGEST" ]; then
  (cd "$(dirname "$SRC_BIN")" && sha256sum -c "$DIGEST" >/dev/null 2>&1) \
    && say "Binary SHA-256 verified" || warn "digest check warned — staging anyway"
fi

# --- 2. stage the bundle ----------------------------------------------------
say "Staging multi-client bundle -> $EXPORT_DIR"
mkdir -p "$EXPORT_DIR/.claude-plugin"
install -m 0755 "$SRC_BIN" "$EXPORT_DIR/$BIN_FILE"
# Carry the repo's provenance digest (commit line + hash) when the staged binary
# matches it — the normal dev case, so the guest sees which commit it came from.
# Otherwise regenerate a bare hash so the guest can still verify.
repo_hash="$(awk '/^[0-9a-f]{64}[[:space:]]/{print $1; exit}' "$MARKET_ROOT/SHA256SUMS" 2>/dev/null)"
export_hash="$(sha256sum "$EXPORT_DIR/$BIN_FILE" | awk '{print $1}')"
if [ -n "$repo_hash" ] && [ "$repo_hash" = "$export_hash" ]; then
  cp "$MARKET_ROOT/SHA256SUMS" "$EXPORT_DIR/SHA256SUMS"
else
  (cd "$EXPORT_DIR" && sha256sum "$BIN_FILE" > SHA256SUMS)
fi
# The Claude marketplace manifest + all three plugin folders.
cp "$MARKET_ROOT/.claude-plugin/marketplace.json" "$EXPORT_DIR/.claude-plugin/marketplace.json"
rm -rf "$EXPORT_DIR/plugins"
cp -r "$MARKET_ROOT/plugins" "$EXPORT_DIR/plugins"
# The plugin bin/ holds a per-machine symlink to the installed binary; never
# ship it — the guest installer recreates it against the guest's ~/.local/bin.
rm -rf "$EXPORT_DIR/plugins/zero-memory-claude/bin"
# Python bytecode caches are per-interpreter build junk: they appear as soon as
# a Hermes profile imports the plugin from a working copy, and shipping them
# would put one machine's compiled bytecode into every guest's install tree.
find "$EXPORT_DIR/plugins" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
# Every per-client installer + re-home helper (they live beside this script in
# scripts/plugin-bundle/). A guest runs their client's installer with NO arg
# (install mode) from the bundle root.
for f in \
  deploy-zm-claude.sh deploy-zm-codex.sh deploy-zm-cursor.sh deploy-zm-hermes.sh \
  deploy-zm-claude-remote-host.sh deploy-zm-codex-remote-host.sh deploy-zm-cursor-remote-host.sh \
  deploy-zm-hermes-remote-host.sh; do
  for cand in "$MARKET_ROOT/scripts/plugin-bundle/$f" "$SCRIPT_DIR/$f"; do
    [ -f "$cand" ] && { install -m 0755 "$cand" "$EXPORT_DIR/$f"; break; }
  done
  [ -f "$EXPORT_DIR/$f" ] || warn "missing installer $f — not staged."
done
# The shared hook wiring lives in scripts/ (next to build-watcher.sh), not in
# plugin-bundle/ — it is also used by a source machine's own `start`. Stage it
# flat so the Claude installer's --with-ingest finds it beside itself in the
# bundle. It applies whatever set the binary declares, so it needs no update
# when a hook is added.
for cand in "$MARKET_ROOT/scripts/wire-hooks.sh" "$SCRIPT_DIR/../wire-hooks.sh"; do
  [ -f "$cand" ] && { install -m 0755 "$cand" "$EXPORT_DIR/wire-hooks.sh"; break; }
done
[ -f "$EXPORT_DIR/wire-hooks.sh" ] || warn "missing wire-hooks.sh — not staged."
# Same treatment for the shared server-address helper every installer sources:
# it is what asks the guest which server to use, checks it and stores the
# answer. Without it in the bundle root the installers refuse to run — which is
# the point: a guest must never be silently pointed at someone else's machine.
for cand in "$MARKET_ROOT/scripts/zm-server-url.sh" "$SCRIPT_DIR/../zm-server-url.sh"; do
  [ -f "$cand" ] && { install -m 0755 "$cand" "$EXPORT_DIR/zm-server-url.sh"; break; }
done
[ -f "$EXPORT_DIR/zm-server-url.sh" ] || warn "missing zm-server-url.sh — not staged."
# The platform helper travels too: it is how an installer refuses a bundle built
# for another machine, which is the mistake a release page with several
# downloads makes easy to make.
for cand in "$MARKET_ROOT/scripts/zm-platform.sh" "$SCRIPT_DIR/../zm-platform.sh"; do
  [ -f "$cand" ] && { install -m 0755 "$cand" "$EXPORT_DIR/zm-platform.sh"; break; }
done
[ -f "$EXPORT_DIR/zm-platform.sh" ] || warn "missing zm-platform.sh — not staged."

# --- 3. self-describing README + VERSION ------------------------------------
# Otherwise the version is buried in plugin.json and you cannot tell what a
# copied bundle holds. Generated (never committed).
BUNDLE_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$EXPORT_DIR/plugins/zero-memory-claude/.claude-plugin/plugin.json" 2>/dev/null | head -n1)"
BUNDLE_VERSION="${BUNDLE_VERSION:-unknown}"
printf '%s\n' "$BUNDLE_VERSION" > "$EXPORT_DIR/VERSION"

# --- 3b. bundle.json — what this archive IS, in machine-readable form --------
# VERSION answers "which release"; this answers "for which machine", which is
# the question a download page cannot ask on the reader's behalf. Installers
# read `target` and refuse a bundle built elsewhere. Keep the field set small
# and stable: it is a contract between a published archive and an installer that
# may be older or newer than it.
BUNDLE_OS="${BUNDLE_TARGET%%-*}"
BUNDLE_ARCH="${BUNDLE_TARGET#*-}"
cat > "$EXPORT_DIR/bundle.json" <<JSON
{
  "name": "zero-memory-client-bundle",
  "version": "$BUNDLE_VERSION",
  "target": "$BUNDLE_TARGET",
  "os": "$BUNDLE_OS",
  "arch": "$BUNDLE_ARCH",
  "binary": {
    "file": "$BIN_FILE",
    "sha256": "$export_hash"
  },
  "clients": ["claude", "codex", "cursor", "hermes"]
}
JSON

{
  printf '# zero-memory — cross-session memory for coding agents\n\n'
  printf 'Persistent shared memory (recall / build_context / remember) for Claude\n'
  printf 'Code, Codex, Cursor, and Hermes, via the zero-memory MCP server plus a\n'
  printf 'per-client plugin (briefing/ingest hooks + a memory-first rule). This\n'
  printf 'bundle installs any of the four from local disk — no central store.\n\n'
  printf -- '- Plugin version: **%s**\n' "$BUNDLE_VERSION"
  printf -- '- Platform: **%s** (this bundle runs only here — see `bundle.json`)\n' "$BUNDLE_TARGET"
  printf -- '- Watcher binary sha256: `%s`\n' "$export_hash"
  printf -- '- Claude Code install id: `%s` (marketplace `%s`)\n' "$PLUGIN_ID" "$MARKETPLACE_NAME"
  printf -- '- Exported: %s\n\n' "$(date -Is)"
} > "$EXPORT_DIR/README.md"
if [ "${BUNDLE_TARGET%%-*}" = "windows" ]; then
  cat >> "$EXPORT_DIR/README.md" <<'EOF'
## Before you start (Windows)

The installers are shell scripts: run them from **Git Bash**, not from
PowerShell or cmd. Everything they touch — the binary in `~/.local/bin`, the
client config under your user profile — is reachable from that shell. Add
`~/.local/bin` to your PATH if it is not there yet, or call the binary by its
full path.

EOF
fi
cat >> "$EXPORT_DIR/README.md" <<'EOF'
## Install

Pick your client and run its installer from this directory, then authorize once
with `zero-memory-watcher login`. Each installer wires the `zero-memory` MCP
server at user scope (tools stay named `mcp__zero-memory__*`) plus that client's
plugin, and is idempotent (safe to re-run). The `*-remote-host.sh` variant first
copies the bundle to local disk, then installs from there — use it over an
unreliable network mount.

**Which server?** The installer asks for your zero-memory server's MCP URL
(e.g. `https://memory.example.com/mcp`), checks that it answers, and stores it
in `~/.config/zero-memory/config.json` — the one place the editor registration,
the hooks and the ingest daemon all read. Pass it non-interactively with
`ZM_SERVER_URL=<url> bash deploy-zm-<client>.sh`. There is no default: this
bundle has no way to know your server, and pointing you at a guess would be
worse than asking. To move a machine later: `zero-memory-watcher login <url>`.

| Client      | Install                    | Re-home + install                     |
| ----------- | -------------------------- | ------------------------------------- |
| Claude Code | `bash deploy-zm-claude.sh` | `bash deploy-zm-claude-remote-host.sh` |
| Codex       | `bash deploy-zm-codex.sh`  | `bash deploy-zm-codex-remote-host.sh`  |
| Cursor      | `bash deploy-zm-cursor.sh` | `bash deploy-zm-cursor-remote-host.sh` |
| Hermes      | `bash deploy-zm-hermes.sh` | `bash deploy-zm-hermes-remote-host.sh` |

Claude Code adds the `/zm:brief`, `/zm:receipt`, `/zm:triage` commands. After
installing, fully reload the client (Claude Code: Developer: Reload Window) and
start a new session so the hooks load.
EOF

# --- 4. validate the Claude marketplace (best-effort) -----------------------
CLAUDE="$(command -v claude || true)"
[ -z "$CLAUDE" ] && [ -x "$HOME/.local/bin/claude" ] && CLAUDE="$HOME/.local/bin/claude"
if [ -n "$CLAUDE" ]; then
  "$CLAUDE" plugin validate "$EXPORT_DIR" --strict >/dev/null 2>&1 \
    && say "Bundle staged and Claude marketplace validated: $EXPORT_DIR" \
    || warn "Bundle staged, but Claude validation warned — inspect $EXPORT_DIR."
else
  say "Bundle staged: $EXPORT_DIR (claude CLI absent — skipped marketplace validation)"
fi
say "Guests install from here — see $EXPORT_DIR/README.md"

# --- 5. pack the archive (--zip) --------------------------------------------
# The published form of the same folder. It is named for the release AND the
# platform — `zm-bundle-<version>-<target>.zip` — so builds for other platforms
# sit beside it on a download page without any of them being renamed, and so a
# file that has been moved between machines still says what it is.
#
# The archive holds ONE top-level directory (the same name), the shape every
# unzip lands cleanly: extracting never scatters files into the current folder.
# A checksum file is written next to it because a download is worth verifying.
# Both formats pack the SAME staged copy, so a release's .tar.gz and .zip can
# never hold different trees. tar.gz is the primary form (it keeps unix modes
# and symlinks without argument); zip stays because it is what a Windows
# machine opens with nothing installed.
if [ -n "$ZIP_DIR" ] || [ -n "$TAR_DIR" ]; then
  ARCHIVE_NAME="zm-bundle-${BUNDLE_VERSION}-${BUNDLE_TARGET}"
  STAGE_PARENT="$(mktemp -d)"
  trap 'rm -rf "$STAGE_PARENT"' EXIT
  cp -a "$EXPORT_DIR" "$STAGE_PARENT/$ARCHIVE_NAME"
fi

pack_checksum() {
  (cd "$(dirname "$1")" && sha256sum "$(basename "$1")" > "$(basename "$1").sha256")
  say "Archive: $1"
  say "Checksum: ${1}.sha256"
}

if [ -n "$TAR_DIR" ]; then
  mkdir -p "$TAR_DIR"
  TAR_ABS="$(cd "$TAR_DIR" && pwd)/${ARCHIVE_NAME}.tar.gz"
  rm -f "$TAR_ABS"
  # With GNU tar the archive is made reproducible — same tree in, same bytes
  # out — so a rebuild of a release can be compared against the published file.
  # Any other tar still produces a correct archive, just not a comparable one.
  if tar --version 2>/dev/null | head -n1 | grep -qi 'gnu tar'; then
    (cd "$STAGE_PARENT" && tar --sort=name --mtime='@0' --owner=0 --group=0 \
      --numeric-owner -czf "$TAR_ABS" "$ARCHIVE_NAME")
  else
    (cd "$STAGE_PARENT" && tar -czf "$TAR_ABS" "$ARCHIVE_NAME")
  fi
  pack_checksum "$TAR_ABS"
fi

if [ -n "$ZIP_DIR" ]; then
  command -v zip >/dev/null 2>&1 || die "'zip' is required for --zip. Install zip."
  mkdir -p "$ZIP_DIR"
  ZIP_ABS="$(cd "$ZIP_DIR" && pwd)/${ARCHIVE_NAME}.zip"
  rm -f "$ZIP_ABS"
  # -y keeps symlinks as symlinks; -q because the file list is the README's job.
  (cd "$STAGE_PARENT" && zip -qry "$ZIP_ABS" "$ARCHIVE_NAME")
  pack_checksum "$ZIP_ABS"
fi

say "Summary: binary=${BINARY_SOURCE:-unknown}, sha=${export_hash:0:16}…, version=$BUNDLE_VERSION, target=$BUNDLE_TARGET"
