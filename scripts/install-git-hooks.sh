#!/usr/bin/env bash
# Idempotently install this repository's LOCAL git hooks.
#
# WHY THIS EXISTS RATHER THAN A HAND-WRITTEN .git/hooks FILE. `.git/hooks` is
# untracked, so a hook written by hand on one machine is invisible everywhere
# else and its failure mode is SILENCE — the same trap the agent-hook wiring
# already learned (see wire-hooks.sh). Declaring them here makes the set
# reviewable and reproducible; running this script is the only install step.
#
# Guarantees: foreign hook content is never touched — a hook that does not
# carry our marker is left alone with a warning; re-running rewrites only the
# marked block.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
hooks="$(git -C "$root" rev-parse --git-common-dir)/hooks"
marker="# zero-memory managed hook"
# One-time adoption: the first post-merge hook was hand-written before this
# installer existed, so it carries no marker. Recognize its exact opening line
# as ours too — narrow enough that a genuinely foreign hook is still refused.
legacy_marker="# zero-memory: flag this merge"
mkdir -p "$hooks"

install_hook() {
  local name="$1" body="$2" path="$hooks/$1"
  if [ -e "$path" ] \
    && ! grep -q "$marker" "$path" 2>/dev/null \
    && ! grep -q "$legacy_marker" "$path" 2>/dev/null; then
    echo "warning: $name exists and is not ours — leaving it alone" >&2
    return 0
  fi
  printf '%s\n' "$body" > "$path"
  chmod +x "$path"
  echo "installed: $name"
}

# post-merge — two jobs, both cheap and both fail-open:
#   1. flag the merge as awaiting its durable-status sync (the session-start
#      hook keeps surfacing the marker until it is deleted);
#   2. when the merge landed on `main`, materialize the snapshot into the local
#      mirror clone. That is the SIGNAL the release contour is built on: main
#      moving is what makes the mirror clone advance, locally and with no
#      network, so the clone is the authority for what may later be published.
#      Publishing stays a separate, deliberate command.
install_hook post-merge "$(cat <<'HOOK'
#!/bin/sh
# zero-memory managed hook
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
[ -n "$common_dir" ] || exit 0
printf '{"detected_at":"%s","source":"git merge (native post-merge hook)"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$common_dir/zm-merge-sync-pending" 2>/dev/null

# Mirror materialization, only on main, only when the clone is configured.
[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] || exit 0
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
env_file="$root/refs/zero-memory-infra/deploy/instance.env"
[ -f "$env_file" ] || exit 0
mirror_dir=$(sed -n 's/^MIRROR_DIR=//p' "$env_file" | tail -1)
[ -n "$mirror_dir" ] && [ -d "$mirror_dir/.git" ] || exit 0
# Never fail a merge because publishing plumbing had a bad day.
"$root/scripts/mirror-snapshot.sh" "$mirror_dir" || \
  echo "zero-memory: mirror snapshot skipped (see above)" >&2
exit 0
HOOK
)"
