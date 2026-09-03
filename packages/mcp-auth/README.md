# `@workspace/mcp-auth`

Embedded OAuth 2.1 authorization server over Supabase Auth, packaged as an
Elysia plugin, so MCP clients can authorize against the memory server
directly. The AS mints no tokens of its own — a session IS a Supabase
session.

## Role in the architecture

Interface adapter (auth protocol layer) with two ports and their Supabase
adapters. Depends on `elysia`, `@supabase/supabase-js`, `@workspace/db`,
`@workspace/logger`, and `zod`. `apps/server` mounts the plugin and uses
`unauthorizedResponse` in its `/mcp` transport.

## Key exports

- `mcpAuthPlugin({ issuer })` — Elysia plugin serving RFC 8414 / RFC 9728
  metadata, `/oauth/register` (dynamic client registration),
  `/oauth/authorize` (login page + code issuance), and `/oauth/token`
  (`authorization_code` + `refresh_token`). Public clients only: PKCE S256
  mandatory, no client secrets.
- `unauthorizedResponse(issuer, description?)` / `buildWwwAuthenticate` —
  401 challenge pointing at the protected-resource metadata.
- Ports: `IAuthGateway` (identity provider), `IOAuthStore` (clients +
  one-time codes; single-use enforced by delete-returning `consumeCode`).
- Adapters: `SupabaseAuthGateway`, `SupabaseOAuthStore` (service role — both
  tables are deny-all under RLS), `InMemoryOAuthStore` (tests).
- `oauth.schema.ts` — zod schemas for every OAuth request/response;
  `verifyPkceS256`, redirect-URI validation helpers, `renderLoginPage`.

## Environment variables

Read by the default Supabase adapters:

| Variable                    | Purpose                                  |
| --------------------------- | ---------------------------------------- |
| `SUPABASE_URL`              | Supabase project URL                     |
| `SUPABASE_ANON_KEY`         | Password login / token refresh (gateway) |
| `SUPABASE_SERVICE_ROLE_KEY` | OAuth client/code storage (store)        |

## Testing

`bun run test:vitest` — PKCE, redirect-URI, and token-flow specs.
