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
# ZM_BUILD_VERSION and ZM_BUILD_COMMIT, when set, name the build that /healthz
# and the pages report (the pipeline sets them from the release tag).
#
# After the deploy, one direct invocation makes a server instance load the
# embedding model, and one request each wakes the dashboard and the docs. The
# first read of a new image is slow (close to a minute measured for the
# server's model); this pays it before anyone arrives. Needs the AWS CLI.
set -euo pipefail

stage="${1:-stand}"
shift || true
repo="$(cd "$(dirname "$0")/../../.." && pwd)"

build() {
  docker build -f "$repo/apps/$1/Dockerfile" -t "zero-memory-$1:aws-${stage}" \
    --build-arg ZM_BUILD_VERSION="${ZM_BUILD_VERSION:-}" \
    --build-arg ZM_BUILD_COMMIT="${ZM_BUILD_COMMIT:-}" \
    "$repo"
  docker image inspect --format '{{.Id}}' "zero-memory-$1:aws-${stage}"
}
server_id="$(build server | tail -1)"
web_id="$(build web | tail -1)"
docs_id="$(build docs | tail -1)"

cd "$repo/infra/aws"
outputs="cdk.out/outputs-${stage}.json"
bunx cdk deploy "zero-memory-web-${stage}" "zero-memory-${stage}" \
  --require-approval "${CDK_REQUIRE_APPROVAL:-broadening}" \
  --outputs-file "$outputs" \
  -c stage="$stage" \
  -c serverImage="zero-memory-server:aws-${stage}" -c serverImageId="$server_id" \
  -c webImage="zero-memory-web:aws-${stage}" -c webImageId="$web_id" \
  -c docsImage="zero-memory-docs:aws-${stage}" -c docsImageId="$docs_id" \
  "$@"

for page in "$(jq -r --arg stack "zero-memory-web-${stage}" '.[$stack].DashboardUrl' "$outputs")/login" \
  "$(jq -r --arg stack "zero-memory-web-${stage}" '.[$stack].DocsUrl' "$outputs")/"; do
  echo "wake: $(curl -s -o /dev/null -w '%{http_code} %{time_total}s' "$page") $page"
done

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
