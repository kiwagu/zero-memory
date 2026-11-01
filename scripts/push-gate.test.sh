#!/usr/bin/env bash
# What push-gate.sh lets through without the e2e smoke — run with
# `bash scripts/push-gate.test.sh` (or `bun run test:push-gate`).
#
# The gate decides whether code may leave the machine without the pre-push
# smoke, so a wrong "proven" skips the last check before a push. These tests
# run the REAL script with real git, in a throwaway repository with a bare
# remote, and check its verdict for each kind of push.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$REPO/scripts/push-gate.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf 'ok     %s\n' "$1"; }
not_ok() { FAIL=$((FAIL + 1)); printf 'FAIL   %s\n' "$1"; }
expect_eq() { # expect_eq <name> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1"; printf '       expected: %s\n       actual:   %s\n' "$2" "$3"; fi
}

# --- a repository whose `public` commit is on the remote and `local` is not --
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
git init -q --bare "$T/remote.git"
git init -q -b main "$T/work"
cd "$T/work" || exit 1
git config user.name test && git config user.email test@example.invalid
echo one > f && git add f && git commit -q -m public
git remote add origin "$T/remote.git"
git push -q origin main
public="$(git rev-parse HEAD)"
git tag v1.0.0 "$public"
git tag -a v1.0.1 -m annotated "$public"
echo two > f && git commit -q -am local
local_sha="$(git rev-parse HEAD)"
local_tree="$(git rev-parse HEAD^{tree})"
zero=0000000000000000000000000000000000000000
proven="$(git rev-parse --git-path zm-e2e-proven-trees)"

# verdict <stdin lines>: the gate's exit status for a push of those lines
verdict() { printf '%s' "$1" | bash "$GATE" origin > "$T/out" 2>&1; echo $?; }

# --- commits already on the remote send no new code -------------------------
expect_eq "a branch already on the remote needs no smoke" 0 \
  "$(verdict "refs/heads/main $public refs/heads/main $zero
")"
expect_eq "a lightweight tag on a public commit needs no smoke" 0 \
  "$(verdict "refs/tags/v1.0.0 $public refs/tags/v1.0.0 $zero
")"
expect_eq "an annotated tag on a public commit needs no smoke" 0 \
  "$(verdict "refs/tags/v1.0.1 $(git rev-parse v1.0.1) refs/tags/v1.0.1 $zero
")"
expect_eq "a deletion sends no code" 0 \
  "$(verdict "(delete) $zero refs/heads/gone $public
")"
expect_eq "an empty push needs no smoke" 0 "$(verdict "")"

# --- a new commit needs the smoke until a passing run proved its tree --------
rm -f "$proven"
expect_eq "a new commit with no proof needs the smoke" 1 \
  "$(verdict "refs/heads/main $local_sha refs/heads/main $public
")"
grep -q "not proven" "$T/out" && ok "the refusal names what is unproven" \
  || not_ok "the refusal names what is unproven"

echo "$(git rev-parse "$public^{tree}") full 2026-11-01T00:00:00Z" > "$proven"
expect_eq "a proof of another tree does not count" 1 \
  "$(verdict "refs/heads/main $local_sha refs/heads/main $public
")"

echo "$local_tree smoke 2026-11-01T00:00:00Z" >> "$proven"
expect_eq "a new commit whose tree a passing run proved needs no smoke" 0 \
  "$(verdict "refs/heads/main $local_sha refs/heads/main $public
")"

# --- one unproven ref is enough to run the smoke -----------------------------
echo three > f && git commit -q -am unproven
expect_eq "a push with one unproven ref needs the smoke" 1 \
  "$(verdict "refs/heads/main $public refs/heads/main $zero
refs/heads/next $(git rev-parse HEAD) refs/heads/next $zero
")"

# --- what cannot be judged runs the smoke ------------------------------------
expect_eq "a ref that names no commit needs the smoke" 1 \
  "$(verdict "refs/tags/blob $(git rev-parse HEAD:f) refs/tags/blob $zero
")"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
