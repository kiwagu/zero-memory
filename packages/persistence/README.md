# `@workspace/persistence`

Supabase adapters for the persistence ports the domain declares, plus the
Supabase client/session helpers.

## Role in the architecture

Infrastructure adapter layer. Nothing here defines behaviour: every class
implements an interface owned by a domain package (`@workspace/memory`,
`@workspace/usage`, `@workspace/policy`, `@workspace/audit`,
`@workspace/extraction`) and translates it into Postgres calls. The dependency
arrow points inward only — the domain never imports this package, which is what
lets a handler be unit-tested against an in-memory double.

Adapters build a per-request client with the caller's JWT from the execution
context, so every query runs under that user's RLS — the database, not the
application, is the enforcement boundary.

## Choosing a client

`supabase.client.ts` exposes three, and picking the wrong one is the easiest
way to open a hole in the isolation model:

- **`createUserClient(accessToken)`** — anon key plus the caller's JWT; the
  default for anything serving a user's own request. Adapters do not filter by
  owner in application code; RLS does it.
- **`createAnonClient()`** — unauthenticated, for sign-in and token refresh.
- **`createServiceRoleClient()`** — bypasses RLS entirely. Legitimate ONLY for
  operational tables that are deny-all to end users (`usage_events`,
  `audit_log`, `usage_daily`, `eval_runs`) and for background passes running
  outside any request. Never for a user-facing read or write — that would move
  the isolation decision into application code, where nothing checks it.

`resolveSupabaseEnv()` fails fast on missing configuration rather than
degrading to a weaker client: a silent downgrade would be a security change
wearing the clothes of a convenience.

## Layout

One directory per aggregate, mirroring the port it implements:

| Path          | What it adapts                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `memory/`     | memories, entities, graph traversal, hybrid search, scope access, export, session receipts, project bindings |
| `usage/`      | the append-only metering ledger and its storage upkeep                                                       |
| `policy/`     | stored allowances and spend summed from the ledger                                                           |
| `credential/` | resolution of a user's own provider key                                                                      |
| `audit/`      | the command-bus audit trail                                                                                  |
| `ingest/`     | the ingest ledger behind idempotent transcript capture                                                       |
| `user/`       | the `auth.users` → `usr_` profile seam                                                                       |

`supabase.client.ts` and `supabase.auth.ts` sit at the root: every adapter
above uses them.

## Key exports

- Adapters (bound to their ports in the app host):
  `SupabaseMemoryRepository`, `SupabaseMemorySearchService` (hybrid
  pgvector + FTS via the `search_memories` RPC), `SupabaseEntityRepository`,
  `SupabaseGraphService` (`traverse_entities` RPC),
  `SupabaseScopeAccessService`, `SupabaseProjectBindingRepository`,
  `SupabaseIngestLogRepository`, `SupabaseUsageRecorder`,
  `SupabaseAuditRecorder`.
- Clients: `createUserClient(accessToken)`, `createAnonClient()`,
  `createServiceRoleClient()`, `resolveSupabaseEnv()`.
- `SupabaseSessionManager` — password sign-in for local/stdio and provisioning
  paths; refreshes the access token shortly before expiry. HTTP MCP clients,
  watcher, and hooks use OAuth instead.

## Background jobs

Two adapters are not request-driven:

- **`UsageUpkeep`** — rolls the monthly partition horizon of `usage_events`
  forward and refreshes the `usage_daily` rollup. Both halves are plain SQL, so
  the server runs it unconditionally rather than behind an opt-in interval like
  the passes that spend on model calls.
- **`SpendMeter`** — derives spend by summing the append-only ledger over a
  trailing window instead of keeping a mutable counter: nothing to decrement
  under concurrency, and any figure a decision was taken on stays reproducible
  from the same rows.

## Conventions

- **Types come from `@workspace/db`**, generated from the schema. Regenerate
  them from the stack the migration was applied to — on a feature branch that
  is the isolated e2e stack, never the live one.
- **Operational tables never carry memory content.** Usage metadata is
  counters and identifiers except for the deliberate, bounded recall `query`,
  truncated before storage. Nothing rewrites a query, so that one field is
  both what the caller sent and what the search ran on.

## Environment variables

| Variable                    | Purpose                                          |
| --------------------------- | ------------------------------------------------ |
| `SUPABASE_URL`              | Supabase project URL                             |
| `SUPABASE_ANON_KEY`         | Anon key                                         |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged key; only the deny-all tables need it |
| `ZM_EMAIL`, `ZM_PASSWORD`   | Credentials for `SupabaseSessionManager`         |

## Scripts

`bun run create-local-user` — idempotently provisions the local development
user (`ZM_EMAIL`/`ZM_PASSWORD`; additionally needs
`SUPABASE_SERVICE_ROLE_KEY`).
