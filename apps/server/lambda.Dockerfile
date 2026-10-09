# Zero-memory MCP server as an AWS Lambda container image.
#
# Built on top of the regular server image, so the dependency closure and the
# source tree are exactly what the listening server runs:
#   docker build -f apps/server/Dockerfile -t zero-memory-server .
#   docker build -f apps/server/lambda.Dockerfile --target runtime-api \
#     --build-arg SERVER_IMAGE=zero-memory-server -t zero-memory-lambda .
#
# Two ways to run Bun on Lambda, one target each:
#   runtime-api  — a custom runtime in TypeScript (src/lambda.ts) pulls
#                  invocations from the Lambda Runtime API itself;
#   web-adapter  — the listening server as is, with the Lambda Web Adapter
#                  extension turning invocations into HTTP requests.
#
# Lambda's file system is read-only except /tmp, hence HOME and the disabled
# transpiler cache. The embedding model is downloaded while the image is
# built, so an instance never fetches it at start. MCP sessions live in
# DynamoDB (ZM_MCP_SESSION_TABLE).

ARG SERVER_IMAGE=zero-memory-server
ARG LWA_VERSION=0.9.1

FROM public.ecr.aws/awsguru/aws-lambda-adapter:${LWA_VERSION} AS lwa

FROM ${SERVER_IMAGE} AS lambda-base
USER root
RUN mkdir -p /opt/zm-models && chown bun:bun /opt/zm-models
USER bun
ENV HOME=/tmp \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    ZM_TRUST_PROXY=true \
    ZM_MODEL_CACHE_DIR=/opt/zm-models
# One embedding call downloads the model into ZM_MODEL_CACHE_DIR.
RUN cd /app/apps/server && bun -e "import { E5SmallEmbeddingService } from '@workspace/embedding'; await new E5SmallEmbeddingService().embed(['warm-up']);"

FROM lambda-base AS runtime-api
ENTRYPOINT ["bun", "apps/server/src/lambda.ts"]

FROM lambda-base AS web-adapter
COPY --from=lwa /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=8787 \
    AWS_LWA_READINESS_CHECK_PATH=/healthz
ENTRYPOINT ["bun", "apps/server/src/index.ts"]
