#!/usr/bin/env bash
# Materialize this repository's tree as a snapshot commit IN THE LOCAL MIRROR
# CLONE. No network: the tree travels over git's local transport, and the
# mirror clone — the only checkout that has a remote — is what later pushes it.
#
# Usage:
#   scripts/mirror-snapshot.sh <mirror-dir> [--source main] [--branch main]
#                                          [--tag vX.Y.Z] [--no-tag]
#
#   --source  local ref whose tree is snapshotted (default: main)
#   --branch  mirror branch to advance (default: main)
#   --tag     cut this exact tag, bypassing the version check (repair only)
#   --no-tag  advance the branch even if the version is unreleased
#
# WHY THE SNAPSHOT IS BUILT HERE AND NOT PUSHED FROM THE WORKING REPO. The
# working repository must not be connected to the mirror host, not even
# indirectly through a URL passed on a command line: the isolation is meant to
# be structural, so that no planning branch, no intermediate edit and no
# mistaken ref can travel outward from a repository that also carries private
# history and refs/. Exactly one component holds the remote — the mirror clone
# — and it carries nothing but published snapshots. A previous revision of this
# contour pushed straight from the working repo; the mirror clone then fell
# behind silently after every release, which is the visible half of the same
# coupling.
#
# RELEASING IS A VERSION BUMP. The version is read from the SNAPSHOTTED tree,
# and when the mirror clone carries no tag for it, `v<version>` is cut onto the
# snapshot. Its own tags are the authority for "what has been released" — no
# network lookup is needed to decide.
#
# Idempotent: snapshotting an unchanged tree is a no-op, so a hook may run it
# on every merge and a publish may re-run it without inventing empty commits.
set -euo pipefail

mirror="${1:?usage: mirror-snapshot.sh <mirror-dir> [--source ref] [--branch name] [--tag vX.Y.Z] [--no-tag]}"
shift
source_ref="main"
branch="main"
tag=""
no_tag=0
while [ $# -gt 0 ]; do
  case "$1" in
    --source) source_ref="$2"; shift 2 ;;
    --branch) branch="$2"; shift 2 ;;
    --tag)    tag="$2"; shift 2 ;;
    --no-tag) no_tag=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

product="$(git rev-parse --show-toplevel)"
[ -d "$mirror/.git" ] || {
  echo "not a git clone: $mirror (the mirror clone is where snapshots live)" >&2
  exit 1
}

# Moving a ref with plumbing does not touch the clone's index or working tree,
# so without this the clone drifts: HEAD advances with every snapshot while the
# checkout stays wherever it last was. That is not merely untidy. The INDEX
# keeps the old tree, so a single `git commit` in the clone — no `-a` needed —
# writes that stale tree on top of the newest snapshot, and the next publish
# sends it to the mirror, where CI builds images from it. The distance between
# a tidy-up and shipping last week's code to production is one command.
#
# Syncing costs a checkout of a small tree and makes the clone honest: `git
# status` clean means "the working copy is what was published", and any real
# difference becomes visible instead of hiding among permanent noise.
sync_mirror_worktree() { # <ref>
  local checked_out
  checked_out="$(git -C "$mirror" symbolic-ref --quiet --short HEAD || true)"
  if [ "$checked_out" != "$branch" ]; then
    # Resetting would move a branch the clone is not on — refuse rather than
    # guess, and say which branch is actually checked out.
    echo "→ mirror is on '${checked_out:-a detached HEAD}', not '${branch}' — leaving its worktree alone"
    return 0
  fi
  git -C "$mirror" reset --hard --quiet "$1"
}

# The tree crosses over git's LOCAL transport — a filesystem path, never a URL.
git -C "$mirror" fetch --no-tags --quiet "$product" "$source_ref"
tree="$(git -C "$mirror" rev-parse FETCH_HEAD^{tree})"

# WHICH TAG THIS RUN CUTS — resolved BEFORE the "nothing to snapshot" exit
# below, because releasing and snapshotting are separate questions and the tree
# being unchanged answers only the second one. It used to sit after that exit,
# so a version bumped in a tree the mirror ALREADY carried could never be
# released: `--tag` was silently dropped and the run reported `tag: -`. That is
# how v0.6.0 reached the mirror untagged — its snapshot had been materialized by
# an earlier attempt, so the retry had nothing to snapshot and cut nothing.
#
# The version comes from the snapshotted tree, not the working directory, so
# snapshotting main from another checkout still releases main's version.
if [ -z "$tag" ] && [ "$no_tag" = 0 ]; then
  version="$(git -C "$mirror" show "FETCH_HEAD:package.json" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
  candidate="v${version}"
  if git -C "$mirror" rev-parse -q --verify "refs/tags/${candidate}" >/dev/null; then
    echo "→ ${candidate} is already released — branch-only snapshot"
  else
    echo "→ ${candidate} is unreleased — cutting it from this snapshot"
    tag="$candidate"
  fi
fi

# A version tag names the build published under it: created, never moved. An
# explicit --tag that already exists is a mistake worth stopping for, so this
# does not swallow git's failure.
cut_tag_at() { # <commit>
  [ -n "$tag" ] || return 0
  git -C "$mirror" tag "$tag" "$1"
}

parent_args=()
if head="$(git -C "$mirror" rev-parse -q --verify "refs/heads/${branch}")"; then
  parent_args=(-p "$head")
  if [ "$(git -C "$mirror" rev-parse "${head}^{tree}")" = "$tree" ]; then
    echo "→ mirror ${branch} already carries this tree — nothing to snapshot"
    # Still sync: a no-op snapshot is exactly when a drifted worktree would
    # otherwise stay drifted forever, because nothing else ever touches it.
    sync_mirror_worktree "$head"
    # The tag still belongs on that existing snapshot: it names the published
    # BUILD, and the build is this tree whether or not this run created it.
    cut_tag_at "$head"
    echo "snapshot: ${head}"
    echo "tag: ${tag:--}"
    exit 0
  fi
else
  echo "→ mirror branch '${branch}' does not exist yet — first snapshot"
fi

snap="$(git -C "$mirror" commit-tree "$tree" "${parent_args[@]}" -m "chore: sync snapshot")"
git -C "$mirror" update-ref "refs/heads/${branch}" "$snap"
sync_mirror_worktree "$snap"
cut_tag_at "$snap"

echo "snapshot: ${snap} (tree of ${source_ref})"
echo "tag: ${tag:--}"
