# `@workspace/mcp-auth`

Embedded OAuth 2.1 authorization server over Supabase Auth, packaged as an
Elysia plugin, so MCP clients can authorize against the memory server
directly. The AS mints no tokens of its own — a session IS a Supabase
session, so row-level security applies to an agent exactly as to its person.

## Role in the architecture

Interface adapter (auth protocol layer) with two ports and their Supabase
adapters. Depends on `elysia`, `@supabase/supabase-js`, `@workspace/db`,
`@workspace/logger`, and `zod`. `apps/server` mounts the plugin and uses
`unauthorizedResponse` in its `/mcp` transport.

## How an agent is authorized

1. The client registers itself (`POST /oauth/register`) and opens
   `GET /oauth/authorize` with PKCE S256 in the person's browser.
2. The server validates the request against the client's registration, parks
   it as a pending authorization (`oaa_` id, 10-minute TTL) and redirects to
   the dashboard: `<webUrl>/oauth/consent?authorization_id=…`.
3. The dashboard makes the person sign in any way the instance offers
   (password, GitHub, Google), then calls
   `GET /oauth/authorizations/:id` with the person's own session as the
   bearer. The first signed-in reader binds the request; anyone else gets 404.
4. The person allows or denies on the consent screen
   (`POST /oauth/authorizations/:id/consent`). Allowing mints a separate
   Supabase session for the agent, parks it behind a one-time code, and
   remembers the consent; the answer is the client's redirect URI with the
   code (or `error=access_denied`).
5. A later authorization of a client the person already approved is answered
   at step 3 with that redirect, with no screen.
6. The client redeems the code at `POST /oauth/token`; refresh tokens rotate
   through the same endpoint.

The agent's session is its own: signing out of the dashboard does not end it,
and it does not sign the person out of the dashboard.

## Key exports

- `mcpAuthPlugin({ issuer, webUrl })` — Elysia plugin serving RFC 8414 /
  RFC 9728 metadata, `/oauth/register`, `/oauth/authorize`, the two consent
  endpoints above, and `/oauth/token` (`authorization_code` +
  `refresh_token`). Public clients only: PKCE S256 mandatory, no client
  secrets. Register, authorize and token are rate-limited per client IP.
- `unauthorizedResponse(issuer, description?)` / `buildWwwAuthenticate` —
  401 challenge pointing at the protected-resource metadata.
- Ports: `IAuthGateway` (verify a bearer token, mint a session for a user,
  refresh), `IOAuthStore` (clients, pending authorizations, consents and
  one-time codes; single use and first-reader binding are enforced in the
  store by conditional writes).
- Adapters: `SupabaseAuthGateway`, `SupabaseOAuthStore` (service role — every
  table is deny-all under RLS), `InMemoryOAuthStore` (tests).
- `oauth.schema.ts` — zod schemas for every request and response, including
  the consent API's; `verifyPkceS256`, redirect-URI validation helpers.

## Environment variables

Read by the default Supabase adapters:

| Variable                    | Purpose                                                   |
| --------------------------- | --------------------------------------------------------- |
| `SUPABASE_URL`              | Supabase project URL                                      |
| `SUPABASE_ANON_KEY`         | Token checks, session redemption and refresh (gateway)    |
| `SUPABASE_SERVICE_ROLE_KEY` | OAuth storage (store); minting an agent session (gateway) |

The dashboard origin (`webUrl`) is passed in by the server, which reads it
from `ZM_WEB_URL`.

## Testing

`bun run test:vitest` — PKCE, redirect-URI, store contract, consent-flow and
token-flow specs. The Supabase adapters are walked end to end by the api e2e.
