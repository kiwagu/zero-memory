#!/usr/bin/env bash
# Whether a push still needs the pre-push e2e smoke. Called by .husky/pre-push
# with the remote's name and URL, and the lines git writes on the hook's stdin:
#
#   <local ref> <local sha> <remote ref> <remote sha>
#
# Exits 0 when nothing the push sends needs the smoke, 1 when something does,
# naming it. A ref needs nothing when:
#   - it deletes (it sends no code);
#   - its commit is already on the destination (a ref the destination holds
#     right now contains it, read with ls-remote rather than from this
#     clone's remote-tracking refs, which can be stale or belong to an earlier
#     URL), as for a tag on a published commit;
#   - its tree is one a passing run of the full or the @smoke suite proved on
#     a clean checkout, as tests/e2e/scripts/run-e2e.ts records it.
# Anything it cannot judge needs the smoke, and so does any failure of this
# script: the hook runs the smoke on every exit but 0.
set -uo pipefail

remote="${1:?usage: push-gate.sh <remote> [<url>] < pre-push lines}"
url="${2:-$1}"
proven="$(git rev-parse --git-path zm-e2e-proven-trees)"
need=0

# The commits the destination's refs name that this clone also has, read once
# and only when a ref is not proven otherwise. Unreadable means unknown, and
# then nothing counts as published.
published=""
published_read=0

on_destination() { # on_destination <commit>
  local unpublished
  if [ "$published_read" -eq 0 ]; then
    published="$(git ls-remote "$url" 2>/dev/null \
      | awk '{ print $1 "^{commit}" }' \
      | git cat-file --batch-check='%(objectname)' 2>/dev/null \
      | grep -v ' missing$' | sort -u)" || published=""
    published_read=1
  fi
  [ -n "$published" ] || return 1
  # Empty when one of them contains the commit; an error counts as unpublished.
  # shellcheck disable=SC2086 # one argument per published commit
  unpublished="$(git rev-list --max-count=1 "$1" --not $published)" || return 1
  [ -z "$unpublished" ]
}

while read -r local_ref local_sha _remote_ref _remote_sha; do
  [ -n "${local_sha:-}" ] || continue
  case "$local_sha" in
    *[!0]*) ;;
    *) continue ;; # all zeros: a deletion
  esac
  if ! commit="$(git rev-parse --verify --quiet "$local_sha^{commit}")"; then
    echo "push-gate: $local_ref names no commit"
    need=1
    continue
  fi
  tree="$(git rev-parse "$commit^{tree}")"
  if [ -f "$proven" ] && proof="$(awk -v tree="$tree" \
    '$1 == tree { proof = $2 " run of " $3 } END { if (proof == "") exit 1; print proof }' \
    "$proven")"; then
    echo "push-gate: $local_ref has a tree a passing $proof proved"
    continue
  fi
  if on_destination "$commit"; then
    echo "push-gate: $local_ref is already on $remote"
    continue
  fi
  echo "push-gate: $local_ref ($(git rev-parse --short "$commit")) is not proven by an e2e run"
  need=1
done

exit "$need"
