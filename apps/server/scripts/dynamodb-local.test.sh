#!/usr/bin/env bash
# Runs the DynamoDB adapters' specs against a throwaway DynamoDB Local
# container on a free port, and removes it afterwards.
set -euo pipefail

cd "$(dirname "$0")/.."
name="zm-dynamodb-test-$$"
docker run -d --rm --name "$name" -p 127.0.0.1::8000 \
  amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -inMemory >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
port="$(docker port "$name" 8000/tcp | head -1 | sed 's/.*://')"
# Docker accepts on the port before the server inside answers; any HTTP status
# means DynamoDB Local is up.
for _ in $(seq 1 100); do
  status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port" || true)"
  [ "$status" != "000" ] && break
  sleep 0.2
done
ZM_DYNAMODB_TEST_ENDPOINT="http://127.0.0.1:$port" \
  bunx vitest run --config vitest.dynamodb.config.ts
