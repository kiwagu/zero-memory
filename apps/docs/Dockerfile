# Zero-memory documentation site (Next.js standalone output).
#
# Build from the repository root (the monorepo is the build context):
#   docker build -f apps/docs/Dockerfile -t zero-memory-docs .
#
# Unlike the server and dashboard images, this one is NOT deployment-agnostic.
# The addresses a page states — where the client archive is downloaded from and
# which instance the reader connects to — are resolved by `lib/client-bundle.ts`
# at BUILD time and baked into the rendered HTML, so they arrive as build
# arguments and changing one is a rebuild, not a restart.

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

# Dev dependencies are needed for `next build` (tailwind, typescript).
# --ignore-scripts skips the root postinstall, which wires up git hooks and the
# merge policy and needs a .git plus a scripts/ directory — neither exists in an
# image build. The docs app has its own postinstall (`fumadocs-mdx`, which
# generates the .source bindings); the build stage runs it explicitly below.
RUN bun install --frozen-lockfile --ignore-scripts

# ── build: produce the standalone server bundle
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

COPY --from=deps /app /app
COPY tsconfig.json ./
COPY packages ./packages
COPY apps/docs ./apps/docs
# The content tree lives outside the app (source.config.ts points at ../../docs)
# and next.config.ts traces it into the bundle.
COPY docs ./docs

ENV NEXT_TELEMETRY_DISABLED=1

# Addresses the pages state. Absent values are not a broken build: the install
# page renders a build-from-source note instead of a dead download button.
ARG ZM_CLIENT_BUNDLE_URL=""
ARG ZM_CLIENT_BUNDLE_VERSION=""
ARG ZM_HOSTED_MCP_URL=""
ARG ZM_HOSTED_WEB_URL=""
ENV ZM_CLIENT_BUNDLE_URL=${ZM_CLIENT_BUNDLE_URL} \
    ZM_CLIENT_BUNDLE_VERSION=${ZM_CLIENT_BUNDLE_VERSION} \
    ZM_HOSTED_MCP_URL=${ZM_HOSTED_MCP_URL} \
    ZM_HOSTED_WEB_URL=${ZM_HOSTED_WEB_URL}

# COPY overlays replace Bun's per-workspace node_modules links. Re-run the
# frozen install after source copy; dependencies are already present from the
# deps stage, so this restores links without another network fetch.
RUN bun install --frozen-lockfile --ignore-scripts
# The generated `.source` bindings are the app's link to the content tree, and
# --ignore-scripts skipped the postinstall that writes them.
RUN bun run --cwd apps/docs postinstall
RUN bun run --cwd apps/docs build

# ── runtime: standalone output only
FROM oven/bun:${BUN_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3200 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=build --chown=bun:bun /app/apps/docs/.next/standalone ./
COPY --from=build --chown=bun:bun /app/apps/docs/.next/static ./apps/docs/.next/static
# Static assets are not part of the standalone bundle and must be copied
# explicitly. Load-bearing, not cosmetic: the screenshots and the client archive
# under public/files/ live here, so without this the pages render while every
# image and the download answer 404.
COPY --from=build --chown=bun:bun /app/apps/docs/public ./apps/docs/public

USER bun

EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e 'fetch("http://127.0.0.1:"+(process.env.PORT??"3200")+"/").then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))'

ENTRYPOINT ["bun", "apps/docs/server.js"]
