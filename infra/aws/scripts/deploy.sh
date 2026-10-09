#!/usr/bin/env bash
# Builds the server image, then deploys the stack that runs it on AWS Lambda.
#
#   AWS_PROFILE=<profile> bash infra/aws/scripts/deploy.sh [stage] [cdk args...]
#
# The Lambda image is built FROM the server image, so the server image is
# built first and its id is handed to CDK: a new server build is a new asset.
# CDK asks before widening IAM permissions; a run without a terminal, after
# `cdk diff` was read, passes CDK_REQUIRE_APPROVAL=never.
#
# After the deploy, one direct invocation makes an instance load the embedding
# model. The first read of a new image's model files is slow (close to a
# minute measured); this pays it before anyone searches. Needs the AWS CLI.
set -euo pipefail

stage="${1:-stand}"
shift || true
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
image="zero-memory-server:aws-${stage}"

docker build -f "$repo/apps/server/Dockerfile" -t "$image" "$repo"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"

cd "$repo/infra/aws"
outputs="cdk.out/outputs-${stage}.json"
bunx cdk deploy \
  --require-approval "${CDK_REQUIRE_APPROVAL:-broadening}" \
  --outputs-file "$outputs" \
  -c stage="$stage" \
  -c serverImage="$image" \
  -c serverImageId="$image_id" \
  "$@"

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
