#!/usr/bin/env bash
# Push the local mirror clone to its remote. THIS IS THE ONLY STEP THAT TALKS
# TO THE MIRROR HOST, and it runs inside the mirror clone — the working
# repository never holds the remote, on purpose (see mirror-snapshot.sh).
#
# Usage:
#   scripts/mirror-publish.sh <mirror-dir> [--branch main] [--dry-run]
#
# What travels: the mirror branch and any version tags the snapshot step cut
# that the remote does not have yet. Tags are pushed one by one, and never
# force-pushed: a version tag names the build that was published under it.
set -euo pipefail

mirror="${1:?usage: mirror-publish.sh <mirror-dir> [--branch main] [--dry-run]}"
shift
branch="main"
dry=()
while [ $# -gt 0 ]; do
  case "$1" in
    --branch)  branch="$2"; shift 2 ;;
    --dry-run) dry=(--dry-run); shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -d "$mirror/.git" ] || { echo "not a git clone: $mirror" >&2; exit 1; }
git -C "$mirror" rev-parse -q --verify "refs/heads/${branch}" >/dev/null || {
  echo "mirror clone has no '${branch}' — run mirror-snapshot.sh first" >&2
  exit 1
}

# Which local tags the remote is missing. `ls-remote` is a read on the mirror's
# own origin, which this clone is entitled to make.
remote_tags="$(git -C "$mirror" ls-remote --tags --refs origin 2>/dev/null |
  awk '{print $2}' | sed 's#refs/tags/##' || true)"
refspecs=("refs/heads/${branch}:refs/heads/${branch}")
while read -r local_tag; do
  [ -n "$local_tag" ] || continue
  printf '%s\n' "$remote_tags" | grep -qx -- "$local_tag" && continue
  refspecs+=("refs/tags/${local_tag}:refs/tags/${local_tag}")
  echo "→ publishing tag ${local_tag}"
done <<< "$(git -C "$mirror" tag)"

# One push for all refs: pre-push hooks run per invocation.
git -C "$mirror" push "${dry[@]}" origin "${refspecs[@]}"
