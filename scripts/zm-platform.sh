#!/usr/bin/env bash
# WHICH MACHINE A BUNDLE IS FOR — the one place that names a platform, sourced
# (not executed) by the bundle builder and by every client installer.
#
# A bundle carries a COMPILED binary, so it is only valid on the platform it was
# built for. That fact has to be visible in three places at once, or a download
# becomes a guess: in the archive's FILE NAME (what you pick on a release page),
# in the bundle's MANIFEST (what the installer can check), and in the error a
# mismatch produces. This file is what keeps those three in agreement.
#
# Naming: `<os>-<arch>` in `uname` spelling — linux-x86_64, windows-x86_64. The
# archive is `zm-bundle-<version>-<target>.<tar.gz|zip>`, the shape a release
# page needs so builds for other platforms can sit BESIDE it without renaming
# anything.
#
# The extension point is the table below: adding a platform means adding its
# row and building on that platform (or cross-compiling with the bun target
# named there) — no other file changes.

# target -> bun --target triple. A target absent here is not supported YET, and
# saying so is the point: half-support that silently produces an unusable binary
# is worse than a refusal.
zm__bun_target() {
  case "$1" in
    linux-x86_64) printf 'bun-linux-x64\n' ;;
    linux-aarch64) printf 'bun-linux-arm64\n' ;;
    windows-x86_64) printf 'bun-windows-x64\n' ;;
    *) return 1 ;;
  esac
}

# This machine, in bundle spelling. Windows shells report their own kernel
# flavour rather than the OS — Git Bash says `mingw64_nt-10.0`, MSYS2 says
# `msys_nt-10.0`, Cygwin says `cygwin_nt-10.0` — and all three run the same
# `windows-x86_64` build, so they are folded into one name here. Folding them
# in this one function is what keeps the archive name, the manifest and the
# installer guard agreeing on Windows the way they already do on Linux.
zm_host_target() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    mingw*|msys*|cygwin*) os="windows" ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

# The file name the watcher binary carries on a target. Windows refuses to
# execute a PE without the extension, so the bundle, the installer and the
# manifest all have to spell it the same way — they get it from here.
zm_binary_file() {
  case "${1:-$(zm_host_target)}" in
    windows-*) printf 'zero-memory-watcher.exe\n' ;;
    *) printf 'zero-memory-watcher\n' ;;
  esac
}

# True when the bundle spelling is one we can build and install.
zm_target_supported() {
  zm__bun_target "$1" >/dev/null 2>&1
}

# The `target` field of a staged bundle's manifest, or empty when it has none
# (bundles built before the manifest existed).
zm_manifest_target() {
  local manifest="$1/bundle.json"
  [ -f "$manifest" ] || return 0
  if command -v jq >/dev/null 2>&1; then
    jq -r '.target // empty' "$manifest" 2>/dev/null
  else
    sed -n 's/.*"target"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      "$manifest" 2>/dev/null | head -n1
  fi
}

# Refuse a bundle built for another machine — the failure a download page makes
# easy to hit. A bundle with no manifest predates this check and is allowed
# through with a warning rather than blocked.
zm_require_matching_platform() {
  local dir="$1" host bundle
  host="$(zm_host_target)"
  bundle="$(zm_manifest_target "$dir")"
  if [ -z "$bundle" ]; then
    printf '\033[1;33m[!]\033[0m %s\n' \
      "this bundle declares no platform (bundle.json missing) — continuing"
    return 0
  fi
  if [ "$bundle" != "$host" ]; then
    printf '\033[1;31mERROR:\033[0m %s\n' \
      "this bundle is for $bundle, but this machine is $host." >&2
    printf '        %s\n' \
      "Download the $host build instead (zm-bundle-<version>-$host.tar.gz)." >&2
    return 1
  fi
  return 0
}
