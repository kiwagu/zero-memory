# `@workspace/mcp-oauth-client`

OAuth client for headless MCP consumers (the transcript watcher and the Claude
Code hooks). It lets a machine authenticate to the zero-memory MCP server with
the server's embedded OAuth 2.1 flow — no Supabase credentials on the client,
just one interactive login, then autonomous token refresh.

## Role in the architecture

Client-side counterpart to `@workspace/mcp-auth` (the server's authorization
server). It plugs a file-backed `OAuthClientProvider` into the MCP SDK's
`StreamableHTTPClientTransport`, which then attaches the access token, refreshes
it on expiry, and only prompts for authorization when neither token works.

Because auth is OAuth against the MCP endpoint, a client needs **only**
`ZM_SERVER_URL` reachable — not the Supabase gateway. One login serves both the
watcher and the hooks on a machine (shared token store, keyed by server URL).

## Key exports

- `createAuthedTransport(serverUrl, store?)` — a `StreamableHTTPClientTransport`
  wired to the file-backed provider; hand it to an SDK `Client`.
- `runLogin(serverUrl)` — one-time interactive bootstrap: dynamic client
  registration + PKCE authorization code, capturing the redirect on a loopback
  port, printing (and best-effort opening) the URL. Exposed as
  `zero-memory-watcher login` and `bun scripts/zm-login.ts`.
- `FileOAuthProvider` — the `OAuthClientProvider` implementation.
- `OAuthStateStore`, `defaultStatePath`, `oauthEntrySchema`, `oauthStateSchema`
  — the token store and its zod contracts.

## Token store

State lives at `${XDG_STATE_HOME:-~/.local/state}/zero-memory/oauth.json`
(written `0600`), a map of server URL → `{ redirectUri, clientInformation,
tokens, codeVerifier }`. Reads never throw: a missing or corrupt file reads as
"not logged in".

## Environment variables

| Variable         | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `XDG_STATE_HOME` | Overrides the token-store directory (default `~/.local/state`) |

The server URL is passed in by the caller (the watcher/hooks read `ZM_SERVER_URL`).
