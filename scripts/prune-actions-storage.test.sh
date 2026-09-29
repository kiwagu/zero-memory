#!/usr/bin/env bash
# What prune-actions-storage.sh deletes — run with
# `bash scripts/prune-actions-storage.test.sh` (or `bun run test:prune-actions`).
#
# The script runs at the end of every release and deletes through the GitHub
# API, so a wrong filter costs a release's rerun its caches or an in-flight
# run its artifacts. These tests run the REAL script against a stub `gh` that
# serves canned API pages and records every DELETE, and check exactly which
# caches and artifacts it removes.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf 'ok     %s\n' "$1"; }
not_ok() { FAIL=$((FAIL + 1)); printf 'FAIL   %s\n' "$1"; }
expect_eq() { # expect_eq <name> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1"; printf '       expected: %s\n       actual:   %s\n' "$2" "$3"; fi
}

# --- a stub gh: canned pages by path, DELETEs recorded -----------------------
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = api ] && [ "$2" = -X ] && [ "$3" = DELETE ]; then
  echo "$4" >> "$GH_STUB_LOG"
  exit 0
fi
[ "$1" = api ] || exit 2
case "$2" in
  repos/o/r) echo '{"default_branch":"main"}' ;;
  "repos/o/r/actions/caches?per_page=100") cat <<'JSON'
{"actions_caches":[
 {"id":11,"ref":"refs/heads/refs/tags/v0.32.0","key":"buildkit-blob-current"},
 {"id":12,"ref":"refs/tags/v0.32.0","key":"zm-models-current"},
 {"id":13,"ref":"refs/heads/refs/tags/v0.31.0","key":"buildkit-blob-earlier"},
 {"id":14,"ref":"refs/tags/v0.30.0","key":"zm-models-earlier"},
 {"id":15,"ref":"refs/heads/main","key":"bun-default-branch"}]}
JSON
  ;;
  "repos/o/r/actions/runs?status=in_progress&per_page=100")
    echo '{"workflow_runs":[{"id":200},{"id":300}]}' ;;
  repos/o/r/actions/runs*) echo '{"workflow_runs":[]}' ;;
  "repos/o/r/actions/artifacts?per_page=100") cat <<'JSON'
{"artifacts":[
 {"id":21,"name":"bundle-linux-x86_64","expired":false,"workflow_run":{"id":200}},
 {"id":22,"name":"e2e-web-results","expired":false,"workflow_run":{"id":200}},
 {"id":23,"name":"bundle-linux-x86_64","expired":false,"workflow_run":{"id":300}},
 {"id":24,"name":"o~r~ABC.dockerbuild","expired":false,"workflow_run":{"id":100}},
 {"id":25,"name":"bundle-windows-x86_64","expired":true,"workflow_run":{"id":100}}]}
JSON
  ;;
  *) echo "stub gh: unexpected path $2" >&2; exit 3 ;;
esac
STUB
chmod +x "$T/bin/gh"

run() { # run [args...] — the release of tag v0.32.0, from run 200
  : > "$T/deleted"
  PATH="$T/bin:$PATH" GH_STUB_LOG="$T/deleted" GH_REPO=o/r CURRENT_RUN_ID=200 \
    bash "$REPO/scripts/prune-actions-storage.sh" refs/tags/v0.32.0 "$@" > "$T/out" 2>&1
}

# --- what a release deletes ----------------------------------------------------
run
status=$?
expect_eq "a release's pruning succeeds" 0 "$status"
expect_eq "caches: only other tags' go; this tag's (either spelling) and the default branch's stay" \
  "repos/o/r/actions/caches/13 repos/o/r/actions/caches/14" \
  "$(grep '/caches/' "$T/deleted" | sort | xargs)"
expect_eq "artifacts: this run's bundles and a finished run's go; an in-flight run's and this run's report stay" \
  "repos/o/r/actions/artifacts/21 repos/o/r/actions/artifacts/24" \
  "$(grep '/artifacts/' "$T/deleted" | sort | xargs)"

# --- a dry run deletes nothing -------------------------------------------------
run --dry-run
expect_eq "a dry run deletes nothing" "" "$(cat "$T/deleted")"
expect_eq "a dry run names what it would delete" 4 "$(grep -c '^  would delete' "$T/out")"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
