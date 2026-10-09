#!/usr/bin/env bash
# Builds the server image, then deploys the stack that runs it on AWS Lambda.
#
#   AWS_PROFILE=<profile> bash infra/aws/scripts/deploy.sh [stage] [cdk args...]
#
# The Lambda image is built FROM the server image, so the server image is
# built first and its id is handed to CDK: a new server build is a new asset.
# CDK asks before widening IAM permissions; a run without a terminal, after
# `cdk diff` was read, passes CDK_REQUIRE_APPROVAL=never.
set -euo pipefail

stage="${1:-stand}"
shift || true
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
image="zero-memory-server:aws-${stage}"

docker build -f "$repo/apps/server/Dockerfile" -t "$image" "$repo"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"

cd "$repo/infra/aws"
bunx cdk deploy \
  --require-approval "${CDK_REQUIRE_APPROVAL:-broadening}" \
  -c stage="$stage" \
  -c serverImage="$image" \
  -c serverImageId="$image_id" \
  "$@"
