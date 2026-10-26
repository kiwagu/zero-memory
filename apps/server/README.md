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
  AsyncLocalStorage context, so persistence acts under that user's RLS. The
  McpServer is built per request; an MCP session is a record in an
  `IMcpSessionStore` (`src/mcp-session.store.ts`): in process memory by
  default, in DynamoDB when `ZM_MCP_SESSION_TABLE` names a table. `GET /mcp`
  answers 405: the server sends nothing outside a response.
- `src/lambda.ts` — the same HTTP handler as an AWS Lambda function behind a
  function URL: a custom runtime on the Lambda Runtime API, which drains the
  request's side writes (`drainDetached`) before posting each response,
  because Lambda freezes the process once a response is out. Sessions and
  the OAuth rate limiter's counts live in DynamoDB
  (`src/rate-limit.dynamodb-limiter.ts`), shared by every instance. Behind
  the edge it answers only requests carrying `x-origin-verify`, and takes the
  client's address from the edge's `x-viewer-address`, never from the
  `X-Forwarded-For` a client sent (`src/lambda.config.ts`). A direct
  invocation with `{"zeroMemory":"warm-up"}` loads the embedding model; one
  with `{"zeroMemory":"job","job":"usage-upkeep|translation|hygiene"}` runs
  that timed job once (`src/lambda.jobs.ts`), through the same run function
  the in-process scheduler (`src/*-scheduler.ts`) calls on a container host.
  Work a request starts in the background (`runInBackground` from
  `@workspace/logger`: the check and translation of a new memory, a
  `scan_hygiene` run, a benchmark) would stall once the instance freezes, so
  when `ZM_JOBS_FUNCTION` names the jobs function the server hands each one
  to it as an asynchronous invocation (`hygiene-one`, `translation`,
  `hygiene-scan`, `benchmark-probes`, `benchmark-run`).
  Built as a container image by `lambda.Dockerfile` (`runtime-api` target;
  the `web-adapter` target runs `src/index.ts` behind the Lambda Web
  Adapter). `scripts/lambda-spike/` runs it locally under the AWS Runtime
  Interface Emulator with DynamoDB Local.
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

| Variable               | Purpose                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `PORT`                 | HTTP port (default `8787`)                                                                            |
| `ZM_PUBLIC_URL`        | Public base URL / OAuth issuer (default `http://localhost:<port>`)                                    |
| `ZM_EXTRACTOR`         | `deterministic` swaps in the test extractor (no API key needed)                                       |
| `ZM_JUDGE_FAKE`        | tests only: `1` binds a deterministic judge and a dummy platform credential; never on a serving stack |
| `ZM_MCP_SESSION_TABLE` | DynamoDB table for MCP sessions; unset keeps them in memory                                           |
| `ZM_RATE_LIMIT_TABLE`  | DynamoDB table for rate-limit counts (Lambda only, required there)                                    |
| `ZM_MCP_JSON_RESPONSE` | `on` answers MCP POSTs with one JSON body instead of SSE                                              |

The wired adapters read their own variables — `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `ZM_EMAIL`, `ZM_PASSWORD`, `ANTHROPIC_API_KEY`, … — see
the READMEs of `@workspace/persistence`, `@workspace/extraction`,
`@workspace/embedding`, `@workspace/mcp-auth`, and `@workspace/logger`.

## Testing

- `bun run test:vitest` — unit specs.
- `bun run test:dynamodb` — the DynamoDB adapters (MCP sessions, rate-limit
  counts) against DynamoDB Local in a throwaway container; needs Docker.
