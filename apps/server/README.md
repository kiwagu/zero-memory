# server

MCP memory server: exposes the schema-first memory, briefing, lifecycle,
hygiene, rules, metrics, import/export, and account-management tools over
streamable HTTP and stdio, backed by Supabase.

## Role in the architecture

App host (composition root). `src/registry/index.ts` wires every port to its
real adapter — Supabase repositories from `@workspace/persistence`, fastembed
from `@workspace/embedding`, the Anthropic extractor from
`@workspace/extraction` — and registers all command/query handlers on the
CQRS buses. Nothing depends on this app; it depends on almost every package.

## Entry points

- `src/index.ts` — Elysia HTTP server (default port 8787): `GET /healthz`
  (liveness), `GET /readyz` (readiness: Supabase reachability + embedder
  warm-state, see `src/readiness.ts` and `infra/prod/RUNBOOK.md`), `GET
/metrics` (Prometheus-format counters), the OAuth 2.1 endpoints from
  `@workspace/mcp-auth`, and the `/mcp` streamable HTTP transport. Every
  `/mcp` request requires a Supabase JWT bearer token and runs inside an
  AsyncLocalStorage context, so persistence acts under that user's RLS.
- `src/mcp-stdio.ts` — stdio transport (also exposed as the
  `zero-memory-mcp` bin). Signs in with `ZM_EMAIL`/`ZM_PASSWORD` and derives
  the default scope from the process cwd (overridden by the client's MCP
  roots).
- `src/http-error.ts` — the routes this app owns answer failures in the shared
  taxonomy (`{error:{code,message,details?}}`, status derived from the code),
  wired as a global `onError` in `src/app.ts` plus a last-resort catch in
  `src/observability.ts`. Deliberately NOT unified: the OAuth endpoints
  (RFC 6749), the Bearer challenge (RFC 6750) and `/mcp` (JSON-RPC) keep the
  bodies their specs prescribe — third-party clients parse them.

## Run

```sh
bun run dev        # HTTP server, watch mode
bun run start      # HTTP server
bun run mcp:stdio  # stdio MCP server
```

## Environment variables

Read directly by this app:

| Variable        | Purpose                                                            |
| --------------- | ------------------------------------------------------------------ |
| `PORT`          | HTTP port (default `8787`)                                         |
| `ZM_PUBLIC_URL` | Public base URL / OAuth issuer (default `http://localhost:<port>`) |
| `ZM_EXTRACTOR`  | `deterministic` swaps in the test extractor (no API key needed)    |

The wired adapters read their own variables — `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `ZM_EMAIL`, `ZM_PASSWORD`, `ANTHROPIC_API_KEY`, … — see
the READMEs of `@workspace/persistence`, `@workspace/extraction`,
`@workspace/embedding`, `@workspace/mcp-auth`, and `@workspace/logger`.
