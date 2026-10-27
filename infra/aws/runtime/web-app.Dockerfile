# A Next.js app of this repository (the dashboard or the documentation site)
# as an AWS Lambda container image: the app's own image, unchanged, plus the
# Lambda Web Adapter and web-app.entry.ts, which loads the app's
# configuration, starts its server and answers only requests from the edge.
#
#   docker build -f infra/aws/runtime/web-app.Dockerfile \
#     --build-arg APP_IMAGE=zero-memory-web --build-arg APP_DIR=apps/web \
#     infra/aws/runtime

ARG APP_IMAGE
ARG LWA_VERSION=0.9.1
ARG BUN_VERSION=1.3.11

FROM public.ecr.aws/awsguru/aws-lambda-adapter:${LWA_VERSION} AS lwa

# The AWS SDK clients the entry needs; the app's image carries only its own
# traced dependencies.
FROM oven/bun:${BUN_VERSION} AS sdk
WORKDIR /opt/zm-web
RUN bun add @aws-sdk/client-secrets-manager@3.1140.0 @aws-sdk/client-ssm@3.1140.0

FROM ${APP_IMAGE}
ARG APP_DIR
USER root
# Next.js writes its cache under .next/cache; on Lambda only /tmp is writable.
RUN rm -rf "/app/${APP_DIR}/.next/cache" \
 && ln -s /tmp/next-cache "/app/${APP_DIR}/.next/cache"
COPY --from=lwa /lambda-adapter /opt/extensions/lambda-adapter
COPY --from=sdk /opt/zm-web/node_modules /opt/zm-web/node_modules
COPY web-app.entry.ts /opt/zm-web/entry.ts
USER bun
ENV HOME=/tmp \
    ZM_APP_DIR=${APP_DIR} \
    ZM_APP_PORT=3999 \
    AWS_LWA_PORT=8080 \
    AWS_LWA_READINESS_CHECK_PATH=/
ENTRYPOINT ["bun", "/opt/zm-web/entry.ts"]
