#!/usr/bin/env bash
# Runs two Lambda containers of the server under the AWS Runtime Interface
# Emulator, the way Lambda runs them (read-only root, writable /tmp, 2 GB),
# with MCP sessions in a DynamoDB Local container on a shared network. The
# embedding model comes from the image, as on Lambda.
#
#   lambda-pair.run.sh <image> <rie-dir> <stack-env-file> <entry...>
#
#   <image>           zero-memory-lambda:runtime-api or :web-adapter
#   <rie-dir>         directory holding the aws-lambda-rie binary
#   <stack-env-file>  SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY of the stand
#   <entry...>        bun apps/server/src/lambda.ts | bun apps/server/src/index.ts
#
# The containers answer on 127.0.0.1:55381 and :55382; put
# function-url.emulator.ts in front of them on :55398. ZM_MCP_JSON_RESPONSE=on
# in the calling shell switches POST answers from SSE to JSON; ZM_ORIGIN_VERIFY
# makes the containers refuse requests without that edge header (give the
# emulator the same value). Stop with `lambda-pair.run.sh --down`.
set -euo pipefail

if [ "${1:-}" = "--down" ]; then
  docker rm -f zm-lambda-1 zm-lambda-2 zm-lambda-dynamodb >/dev/null 2>&1 || true
  docker network rm zm-lambda >/dev/null 2>&1 || true
  exit 0
fi

IMAGE="$1"; RIE_DIR="$2"; STACK_ENV="$3"; shift 3
set -a; . "$STACK_ENV"; set +a
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

docker network create zm-lambda >/dev/null 2>&1 || true
if ! docker inspect zm-lambda-dynamodb >/dev/null 2>&1; then
  docker run -d --name zm-lambda-dynamodb --network zm-lambda \
    -p 127.0.0.1:55390:8000 amazon/dynamodb-local:latest \
    -jar DynamoDBLocal.jar -inMemory -sharedDb >/dev/null
  sleep 2
fi
AWS_REGION=eu-central-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
  bun "$SCRIPT_DIR/session-table.setup.ts" http://127.0.0.1:55390 zm-mcp-sessions

for i in 1 2; do
  docker rm -f "zm-lambda-$i" >/dev/null 2>&1 || true
  docker run -d --name "zm-lambda-$i" --network zm-lambda \
    --read-only --tmpfs /tmp:rw,exec --memory 2g \
    --add-host host.docker.internal:host-gateway -p "127.0.0.1:5538$i:8080" \
    -v "$RIE_DIR:/aws-lambda:ro" \
    -e SUPABASE_URL=http://host.docker.internal:55331 \
    -e SUPABASE_ANON_KEY -e SUPABASE_SERVICE_ROLE_KEY \
    -e AWS_REGION=eu-central-1 -e AWS_ACCESS_KEY_ID=local -e AWS_SECRET_ACCESS_KEY=local \
    -e AWS_ENDPOINT_URL_DYNAMODB=http://zm-lambda-dynamodb:8000 \
    -e ZM_MCP_SESSION_TABLE=zm-mcp-sessions \
    -e ZM_MCP_JSON_RESPONSE="${ZM_MCP_JSON_RESPONSE:-}" \
    -e ZM_ORIGIN_VERIFY="${ZM_ORIGIN_VERIFY:-}" \
    -e ZM_PUBLIC_URL=http://127.0.0.1:55398 -e ZM_WEB_URL=http://localhost:3102 \
    --entrypoint /aws-lambda/aws-lambda-rie "$IMAGE" "$@" >/dev/null
done
echo "lambda pair up on 127.0.0.1:55381 and :55382"
