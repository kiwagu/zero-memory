#!/usr/bin/env bash
# Delete the GitHub Actions caches and artifacts a repository can no longer
# use, so they stop filling its cache allowance and its storage quota. The
# release workflow runs it after publishing a release; by hand it needs a
# token that may write Actions.
#
# Usage:
#   scripts/prune-actions-storage.sh <ref> [--dry-run]
#
#   GH_REPO         owner/name of the repository (the workflow sets it)
#   GH_TOKEN        a token with actions: write (the workflow's own token)
#   CURRENT_RUN_ID  the run doing the pruning, if any
#
# Caches: a run restores only caches saved under its own ref or under the
# default branch. A cache saved under any other ref, an earlier release tag
# above all, is never read again, so every cache outside <ref> and the default
# branch is deleted.
#
# Artifacts: those of runs still in progress stay, except the `bundle-*`
# artifacts of the current run, which the release job has already attached to
# the release. Every other artifact belongs to a finished run and is deleted.
#
# --dry-run lists what would be deleted and deletes nothing.
set -euo pipefail

ref="${1:?usage: prune-actions-storage.sh <ref> [--dry-run]}"
dry_run=false
if [ "${2:-}" = "--dry-run" ]; then
  dry_run=true
fi
repo="${GH_REPO:?GH_REPO must name the repository, as owner/name}"
current_run="${CURRENT_RUN_ID:-}"

deleted=0
failed=0
# remove <api-path> <what>
remove() {
  if $dry_run; then
    echo "  would delete $2"
    deleted=$((deleted + 1))
    return
  fi
  local attempt
  for attempt in 1 2 3 4; do
    if gh api -X DELETE "$1" >/dev/null 2>&1; then
      deleted=$((deleted + 1))
      return
    fi
    # A burst of deletes meets GitHub's secondary rate limit; it clears.
    sleep $((attempt * 15))
  done
  echo "  could not delete $2" >&2
  failed=$((failed + 1))
}

default_branch="$(gh api "repos/${repo}" | jq -r '.default_branch')"

# The API reports a tag's caches under `refs/heads/<ref>` as well as `<ref>`.
while IFS=$'\t' read -r id cache_ref key; do
  case "$cache_ref" in
    "$ref" | "refs/heads/${ref}" | "refs/heads/${default_branch}") continue ;;
  esac
  remove "repos/${repo}/actions/caches/${id}" "cache ${key} (${cache_ref})"
done < <(
  gh api "repos/${repo}/actions/caches?per_page=100" --paginate \
    | jq -r '.actions_caches[] | [.id, .ref, .key] | @tsv'
)
caches=$deleted

active="$current_run"
for status in in_progress queued waiting; do
  active+=$'\n'"$(
    gh api "repos/${repo}/actions/runs?status=${status}&per_page=100" --paginate \
      | jq -r '.workflow_runs[].id'
  )"
done

while IFS=$'\t' read -r id name run; do
  if grep -qxF "$run" <<<"$active"; then
    if [ "$run" != "$current_run" ] || [[ "$name" != bundle-* ]]; then
      continue
    fi
  fi
  remove "repos/${repo}/actions/artifacts/${id}" "artifact ${name} (run ${run})"
done < <(
  gh api "repos/${repo}/actions/artifacts?per_page=100" --paginate \
    | jq -r '.artifacts[] | select(.expired | not) | [.id, .name, .workflow_run.id] | @tsv'
)

verb="deleted"
if $dry_run; then
  verb="would delete"
fi
echo "→ actions storage: ${verb} ${caches} cache(s) and $((deleted - caches)) artifact(s); kept the caches of ${ref} and ${default_branch}"
if [ "$failed" -gt 0 ]; then
  echo "✗ ${failed} deletion(s) failed" >&2
  exit 1
fi
