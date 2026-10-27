#!/usr/bin/env bash
# Builds the images of the server, the dashboard and the docs, then deploys
# the two stacks that run them on AWS Lambda: the web stack first, then the
# server's.
#
#   AWS_PROFILE=<profile> bash infra/aws/scripts/deploy.sh [stage] [cdk args...]
#
# Each Lambda image is built FROM the app's own image, so those are built
# first and their ids are handed to CDK: a new app build is a new asset.
# CDK asks before widening IAM permissions; a run without a terminal, after
# `cdk diff` was read, passes CDK_REQUIRE_APPROVAL=never.
#
# /healthz and the pages report the build as `<version>+<commit>`: the release
# tag the checkout sits on (else the package version) and the checkout's
# commit. A commit copied from another repository's commit names that one in a
# `Source-Commit:` trailer, and the build reports it instead, since it is the
# one people can look up. A checkout with uncommitted changes reports `dev`.
# ZM_BUILD_VERSION and ZM_BUILD_COMMIT, when set, override both.
#
# An instance reads its app's environment secret only when it starts. The
# current version of each secret is stamped into its function, so a deploy
# after a secret changed replaces the running instances, and one after no
# change leaves them alone.
#
# After the deploy, one direct invocation makes a server instance load the
# embedding model, and one request each wakes the dashboard and the docs. The
# first read of a new image is slow (close to a minute measured for the
# server's model); this pays it before anyone arrives. It also starts one
# usage upkeep run and one database backup. Needs the AWS CLI.
set -euo pipefail

stage="${1:-stand}"
shift || true
repo="$(cd "$(dirname "$0")/../../.." && pwd)"

# BuildKit attaches a provenance attestation that records the build's time,
# which gives every build of an unchanged tree a new image id, and so a new
# asset that replaces every function. Without it the id follows the content.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1

if [ -z "${ZM_BUILD_COMMIT:-}" ] && git -C "$repo" diff --quiet HEAD 2>/dev/null; then
  # The first line taken in the shell, not by `head`: under pipefail a reader
  # that stops early can fail the whole pipeline.
  trailer="$(git -C "$repo" log -1 --format='%(trailers:key=Source-Commit,valueonly)')"
  ZM_BUILD_COMMIT="${trailer%%$'\n'*}"
  ZM_BUILD_COMMIT="${ZM_BUILD_COMMIT:-$(git -C "$repo" rev-parse HEAD)}"
  ZM_BUILD_VERSION="${ZM_BUILD_VERSION:-$(git -C "$repo" describe --tags --exact-match 2>/dev/null || true)}"
fi

# Runs inside a command substitution, where `set -e` does not reach: a failed
# build has to fail the function itself, or the inspection below would hand
# CDK the id of the image an earlier build left under the same tag.
build() {
  docker build -f "$repo/apps/$1/Dockerfile" -t "zero-memory-$1:aws-${stage}" \
    --build-arg ZM_BUILD_VERSION="${ZM_BUILD_VERSION:-}" \
    --build-arg ZM_BUILD_COMMIT="${ZM_BUILD_COMMIT:-}" \
    "$repo" || return 1
  docker image inspect --format '{{.Id}}' "zero-memory-$1:aws-${stage}"
}
server_id="$(build server | tail -1)"
web_id="$(build web | tail -1)"
docs_id="$(build docs | tail -1)"
for id in "$server_id" "$web_id" "$docs_id"; do
  [ -n "$id" ] || { echo "an image build produced no image id" >&2; exit 1; }
done

# Empty until the stack has created the secret.
env_version() {
  aws secretsmanager describe-secret --secret-id "zero-memory/${stage}/$1-env" \
    --query VersionIdsToStages --output json 2>/dev/null |
    jq -r 'to_entries[] | select(.value | index("AWSCURRENT")) | .key' || true
}

cd "$repo/infra/aws"
outputs="cdk.out/outputs-${stage}.json"
bunx cdk deploy "zero-memory-web-${stage}" "zero-memory-${stage}" \
  --require-approval "${CDK_REQUIRE_APPROVAL:-broadening}" \
  --outputs-file "$outputs" \
  -c stage="$stage" \
  -c serverImage="zero-memory-server:aws-${stage}" -c serverImageId="$server_id" \
  -c webImage="zero-memory-web:aws-${stage}" -c webImageId="$web_id" \
  -c docsImage="zero-memory-docs:aws-${stage}" -c docsImageId="$docs_id" \
  -c serverEnvVersion="$(env_version server)" \
  -c webEnvVersion="$(env_version web)" \
  -c docsEnvVersion="$(env_version docs)" \
  -c backupEnvVersion="$(env_version backup)" \
  "$@"

for page in "$(jq -r --arg stack "zero-memory-web-${stage}" '.[$stack].DashboardUrl' "$outputs")/login" \
  "$(jq -r --arg stack "zero-memory-web-${stage}" '.[$stack].DocsUrl' "$outputs")/"; do
  echo "wake: $(curl -s -o /dev/null -w '%{http_code} %{time_total}s' "$page") $page"
done

# Usage upkeep also runs once at every start on the container host, so a new
# deployment has its partitions and first rollup at once. Not awaited.
jobs_function="$(jq -r --arg stack "zero-memory-${stage}" '.[$stack].JobsFunctionName' "$outputs")"
if aws lambda invoke --function-name "$jobs_function" --invocation-type Event \
  --cli-binary-format raw-in-base64-out \
  --payload '{"zeroMemory":"job","job":"usage-upkeep"}' /dev/null >/dev/null; then
  echo "usage upkeep: started"
else
  echo "warning: usage upkeep could not be started; the daily schedule will run it" >&2
fi

# One backup now rather than at the next 03:30 UTC: a new deployment would
# otherwise have none for up to a day, and the missing-backup alarm would say
# so. Without a database URL in its secret yet, the run fails and the failure
# alarm names what is missing. Not awaited.
backup_function="$(jq -r --arg stack "zero-memory-${stage}" '.[$stack].BackupFunctionName // empty' "$outputs")"
if [ -n "$backup_function" ]; then
  if aws lambda invoke --function-name "$backup_function" \
    --invocation-type Event /dev/null >/dev/null; then
    echo "backup: started"
  else
    echo "warning: a backup could not be started; the daily schedule will take one" >&2
  fi
fi

function_name="$(jq -r --arg stack "zero-memory-${stage}" '.[$stack].FunctionName' "$outputs")"
answer="$(mktemp)"
trap 'rm -f "$answer"' EXIT
# A first read slower than the function's timeout ends the invocation, but the
# image is read by then; the second attempt finds it fast.
for attempt in 1 2; do
  aws lambda invoke --function-name "$function_name" \
    --cli-binary-format raw-in-base64-out \
    --payload '{"zeroMemory":"warm-up"}' \
    --cli-read-timeout 120 "$answer" >/dev/null || true
  if grep -q '"warm":true' "$answer"; then
    echo "warm-up (attempt $attempt): $(cat "$answer")"
    exit 0
  fi
done
echo "warm-up failed: $(cat "$answer")" >&2
exit 1
