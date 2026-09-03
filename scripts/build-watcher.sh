#!/usr/bin/env bash
# Compile apps/watcher into a single self-contained executable (bun --compile).
#
# The binary embeds the Bun runtime and all bundled JS, so a LAN machine can run
# the transcript watcher WITHOUT a repo clone or a bun install. All config is
# read from the environment at runtime (auth is OAuth via the login command) —
# ZM_SERVER_URL, ZM_WATCH_CHUNK_CHARS — nothing is baked
# in, so one build serves every host of the same platform. (`--compile` also
# autoloads a `.env` from the working directory, a convenient way to supply
# those on the client.)
#
# Usage:
#   bash scripts/build-watcher.sh                          # this host's platform
#   TARGET=bun-linux-arm64 bash scripts/build-watcher.sh   # cross-compile
#
# Cross targets: bun-linux-x64, bun-linux-arm64, bun-darwin-arm64,
#                bun-darwin-x64, bun-windows-x64
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${TARGET:-}"
OUT="${OUT:-dist/zero-memory-watcher}"
[[ "$TARGET" == bun-windows-* ]] && OUT="${OUT}.exe"
mkdir -p "$(dirname "$OUT")"

# `zero-memory-watcher version` falls back to the compiled-in package version
# when the binary runs outside an installed plugin bundle. That number is only
# honest if it matches EVERY plugin this binary ships inside — a support report
# names the plugin version its reporter installed, and that has to identify one
# build rather than one client family. So drift is a build error, not a silently
# wrong version string.
#
# The manifests are DISCOVERED, never listed: a new client plugin joins the
# lockstep by existing, and a hard-coded list would silently leave it behind —
# which is exactly how the Codex and Cursor manifests sat at 0.1.0 while the
# binary inside them moved through fourteen releases.
pkg_ver="$(grep -m1 '"version"' apps/watcher/package.json | cut -d'"' -f4)"
for manifest in plugins/*/.*-plugin/plugin.json; do
  [ -f "$manifest" ] || continue
  manifest_ver="$(grep -m1 '"version"' "$manifest" | cut -d'"' -f4)"
  if [[ "$pkg_ver" != "$manifest_ver" ]]; then
    echo "version drift: apps/watcher/package.json ($pkg_ver) != $manifest ($manifest_ver)" >&2
    echo "bump them together — the binary reports this number as its build version." >&2
    echo "  bun scripts/bump-watcher-version.ts <patch|minor|major>" >&2
    exit 1
  fi
done
# A Hermes plugin declares itself in a root plugin.yaml rather than a JSON
# manifest in a dot-directory, so it needs its own (unquoted) read — same
# lockstep, different shape.
for manifest in plugins/*/plugin.yaml; do
  [ -f "$manifest" ] || continue
  manifest_ver="$(grep -m1 '^version:' "$manifest" | awk '{print $2}')"
  if [[ "$pkg_ver" != "$manifest_ver" ]]; then
    echo "version drift: apps/watcher/package.json ($pkg_ver) != $manifest ($manifest_ver)" >&2
    echo "bump them together — the binary reports this number as its build version." >&2
    echo "  bun scripts/bump-watcher-version.ts <patch|minor|major>" >&2
    exit 1
  fi
done

# Version-honesty gate: a change to the watcher's runtime dependency closure
# since the last version bump must carry a new version — the deployed binary
# reports it to clients, so it has to reflect what actually changed. The gate
# only SIGNALS (deriving the relevant set from the dependency graph); the semver
# level is chosen by hand via scripts/bump-watcher-version.ts. It fires here so
# the signal lands at build/promote (once per release), not on every commit.
# ZM_WATCHER_GATE_PHASE=build tells the gate to skip its digest check: this run
# is the thing that refreshes SHA256SUMS a few lines below, so demanding a fresh
# one first would be a deadlock.
ZM_WATCHER_GATE_PHASE=build bun scripts/watcher-version-gate.ts

args=(build --compile ./apps/watcher/src/index.ts --outfile "$OUT")
[[ -n "$TARGET" ]] && args+=(--target "$TARGET")

bun "${args[@]}"
echo "built: $OUT"
ls -lh "$OUT"

# SHA-256 digest — a trust anchor for the binary. The binary itself is too big
# to commit (dist/ is gitignored), but its fingerprint is tiny: whoever builds
# or receives the binary can `sha256sum -c` it against the digest the repo
# attests. Written next to the binary (basename only, so `-c` works from that
# dir); for the canonical build the committed SHA256SUMS at the repo root is
# refreshed so the shared git history records the expected fingerprint.
out_dir="$(dirname "$OUT")"
out_base="$(basename "$OUT")"
# A `# …` provenance line records WHICH release and WHICH source commit produced
# this binary — `sha256sum -c` skips comment lines, so the file stays verifiable.
# `-dirty` marks a build from an uncommitted tree (fingerprint not reproducible
# from git). The version is on that line because a digest travelling in a guest
# bundle is otherwise anonymous: a bare hash cannot say which release it attests,
# and the commit is meaningless to anyone without this repository. It is the
# watcher package version, which the drift check above pins equal to the plugin
# manifest — so the one field names the plugin release as well.
commit="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
short="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
# Exclude the generated SHA256SUMS itself: regenerating it must not self-flag
# the build as dirty (it is an output, not a source input to the binary).
dirty=""; [ -n "$(git status --porcelain -- ':!SHA256SUMS' 2>/dev/null)" ] && dirty="-dirty"
# Build-env provenance — the factors that ACTUALLY change the compiled hash, so a
# legitimate rebuild on a different toolchain isn't mistaken for tampering. Verified
# 2026-07-13: the hash depends on the bun version, the target platform (arch → the
# default target), the source, and the fixed output basename — but NOT on NODE_ENV
# or other runtime env vars (they are read at runtime, not inlined), and NOT on the
# host OS *distro* version (bun embeds a target-specific runtime blob, not host
# libs — the distro only affects runtime compatibility). The OS is recorded for
# that runtime context. `sha256sum -c` skips this `#` line too.
bun_ver="$(bun --version 2>/dev/null || echo unknown)"
host_arch="$(uname -m)"
host_target="$(uname -s | tr '[:upper:]' '[:lower:]')-$(printf '%s' "$host_arch" | sed 's/x86_64/x64/;s/aarch64/arm64/')"
build_target="${TARGET:-$host_target}"
build_os="$(. /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME" || uname -sr)"
{
  # No build timestamp on purpose: a clean rebuild of the same commit then
  # yields a byte-identical digest file (no git churn, and you can confirm the
  # committed SHA256SUMS reproduces from source).
  printf '# zero-memory-watcher — version %s (binary = plugin manifest) — built from git %s%s (%s)  commit=%s%s\n' \
    "$pkg_ver" "$short" "$dirty" "$branch" "$commit" "$dirty"
  printf '# build-env: bun=%s  target=%s  arch=%s  os=%s\n' \
    "$bun_ver" "$build_target" "$host_arch" "$build_os"
  (cd "$out_dir" && sha256sum "$out_base")
} > "$OUT.sha256"
echo "digest: $OUT.sha256"
if [[ -z "$TARGET" && "$OUT" == "dist/zero-memory-watcher" ]]; then
  # Only rewrite the committed digest when the actual HASH changed. The `#`
  # provenance comment moves on every rebuild (new commit=), but if the binary
  # fingerprint is identical that is pure git churn — refreshing it would dirty
  # SHA256SUMS on a no-op rebuild and force a throwaway commit. Compare just the
  # non-comment (hash) line; leave the file (and its provenance) untouched when
  # it matches.
  new_hash="$(grep -v '^#' "$OUT.sha256")"
  old_hash="$(grep -v '^#' SHA256SUMS 2>/dev/null || true)"
  if [[ "$new_hash" == "$old_hash" ]]; then
    echo "committed SHA256SUMS unchanged (binary hash identical) — not rewriting"
  else
    cp "$OUT.sha256" SHA256SUMS
    echo "updated committed SHA256SUMS (commit ${short}${dirty})"
  fi
fi
