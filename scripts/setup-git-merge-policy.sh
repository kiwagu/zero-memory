#!/usr/bin/env sh
# Makes `git merge <branch>` do the right thing in this repository, so nobody
# has to remember a flag.
#
# THE PROBLEM WITH REMEMBERING: a merge policy that lives in a document is a
# policy that holds only while everyone recalls it at the moment they type the
# command. Fast-forward is git's DEFAULT, it is silent, and it is irreversible
# in the sense that matters — once the branch's commits are replayed onto the
# target there is no merge commit to point at afterwards. So the policy is set
# as configuration, applied automatically on install, rather than written down
# and hoped for.
#
# WHAT IT SETS
#   merge.ff=false   every merge records a merge commit, so a branch stays one
#                    object in history: `git revert -m 1 <merge>` takes a whole
#                    epic back out, and the log shows what arrived together.
#                    This matters most exactly when git would fast-forward —
#                    a branch cut from an unmoved target, which is the normal
#                    case here, since branches are cut from `main`.
#   pull.ff=only     pulls stay linear (they are not merges of work, they are
#                    catch-ups). Harmless here — this checkout has no remote —
#                    but it keeps the two settings from being confused later.
#
# Both are LOCAL to this clone: git config is not a tracked file, which is why
# this script exists and why `prepare`/`postinstall` run it.
#
# Idempotent, and it never overrides a deliberate choice: if the values are
# already what we want it says nothing, and it only writes into the repository's
# own config, never the user's global one.

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

# Not a git checkout (tarball export, container build) — nothing to configure.
[ -d .git ] || exit 0

set_if_needed() {
  key=$1
  want=$2
  have=$(git config --local --get "$key" || true)
  [ "$have" = "$want" ] && return 0
  git config --local "$key" "$want"
  echo "git merge policy: $key=$want"
}

set_if_needed merge.ff false
set_if_needed pull.ff only
