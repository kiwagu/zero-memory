# Zero-memory MCP server.
#
# Build from the repository root (the monorepo is the build context):
#   docker build -f apps/server/Dockerfile -t zero-memory-server .
#
# Most workspace packages run as TypeScript sources under Bun. @workspace/db
# deliberately exports compiled dist at runtime, so its build is copied into
# the final image from a separate full-dependency stage.

ARG BUN_VERSION=1.3.11

# ── deps: manifests only, so the install layer caches until a manifest changes
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/docs/package.json apps/docs/
COPY apps/server/package.json apps/server/
COPY apps/watcher/package.json apps/watcher/
COPY apps/web/package.json apps/web/
COPY packages/audit/package.json packages/audit/
COPY packages/client-adapter-claude/package.json packages/client-adapter-claude/
COPY packages/client-adapter-codex/package.json packages/client-adapter-codex/
COPY packages/client-adapter-cursor/package.json packages/client-adapter-cursor/
COPY packages/client-adapter-hermes/package.json packages/client-adapter-hermes/
COPY packages/client-core/package.json packages/client-core/
COPY packages/client-runtime/package.json packages/client-runtime/
COPY packages/command-handlers/package.json packages/command-handlers/
COPY packages/commands/package.json packages/commands/
COPY packages/context/package.json packages/context/
COPY packages/contracts/package.json packages/contracts/
COPY packages/cqrs/package.json packages/cqrs/
COPY packages/db/package.json packages/db/
COPY packages/di/package.json packages/di/
COPY packages/domain/package.json packages/domain/
COPY packages/email/package.json packages/email/
COPY packages/embedding/package.json packages/embedding/
COPY packages/endpoint-guard/package.json packages/endpoint-guard/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/extraction/package.json packages/extraction/
COPY packages/hygiene/package.json packages/hygiene/
COPY packages/i18n-catalogs/package.json packages/i18n-catalogs/
COPY packages/llm/package.json packages/llm/
COPY packages/logger/package.json packages/logger/
COPY packages/mcp/package.json packages/mcp/
COPY packages/mcp-auth/package.json packages/mcp-auth/
COPY packages/mcp-oauth-client/package.json packages/mcp-oauth-client/
COPY packages/memory/package.json packages/memory/
COPY packages/persistence/package.json packages/persistence/
COPY packages/policy/package.json packages/policy/
COPY packages/queries/package.json packages/queries/
COPY packages/query-handlers/package.json packages/query-handlers/
COPY packages/roi/package.json packages/roi/
COPY packages/translation/package.json packages/translation/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/ui/package.json packages/ui/
COPY packages/usage/package.json packages/usage/
COPY tests/e2e/package.json tests/e2e/

# Scoped to the server workspace (and its transitive workspace deps) —
# keeps web-only dependencies (next, react) out of the image.
RUN bun install --frozen-lockfile --production --filter=server

# ── db build: @workspace/db exports dist/index.js at runtime
FROM deps AS db-build

COPY tsconfig.json ./
COPY packages ./packages

# The production-filtered deps stage intentionally lacks TypeScript. Add the
# full frozen toolchain only in this throwaway build stage, after source copy
# so Bun also recreates the workspace links COPY overlays.
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run --cwd packages/db build

# ── runtime
FROM oven/bun:${BUN_VERSION} AS runtime
WORKDIR /app

# node_modules (isolated-linker store + per-workspace links) and manifests
COPY --from=deps /app /app
COPY tsconfig.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY --from=db-build /app/packages/db/dist ./packages/db/dist

# COPY overlays replace Bun's per-workspace node_modules links. Re-run the
# frozen filtered install after source copy: the package cache is already in
# this stage, so this is a fast relink rather than a second download.
RUN bun install --frozen-lockfile --production --filter=server --ignore-scripts

# Embedding model cache lives on a volume so the ~100 MB ONNX download
# survives container recreation.
ENV NODE_ENV=production \
    PORT=8787 \
    ZM_MODEL_CACHE_DIR=/models
RUN mkdir -p /models && chown bun:bun /models
VOLUME /models

USER bun
# Build identity surfaced by the app (/healthz, page footers): the release
# tag and the built commit, passed by the images CI job. Left empty on a
# local build — the code then falls back to the package version and "dev".
ARG ZM_BUILD_VERSION=""
ARG ZM_BUILD_COMMIT=""
ENV ZM_BUILD_VERSION=${ZM_BUILD_VERSION} \
    ZM_BUILD_COMMIT=${ZM_BUILD_COMMIT}

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e 'fetch("http://127.0.0.1:"+(process.env.PORT??"8787")+"/healthz").then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))'

ENTRYPOINT ["bun", "apps/server/src/index.ts"]
