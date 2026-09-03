# `@workspace/context`

Per-request execution context over `AsyncLocalStorage`: who is calling, with
which access token, and into which default scope memories should go.

## Role in the architecture

Application-layer infrastructure. Depends only on `@workspace/di`; the
application services (`@workspace/memory`, `@workspace/extraction`) and the
Supabase adapters read the current user and JWT from it, which is what makes
RLS-per-user work end to end.

## Key exports

- `runWithContext(context, fn)` — runs `fn` inside an `ExecuteContext`
  (requestId, user, accessToken, scopes, defaultScope).
- `ExecuteContext`, `IContext`, `ContextUser` — context shape and port.
- `CONTEXT_TOKEN`, `injectContext()` — DI token and inject decorator.
- `ServerContext`, `registerContext(container)` — the AsyncLocalStorage-backed
  implementation and its DI registration.
- Getters usable outside DI: `getRequestId`, `getCurrentUserId`,
  `mustGetCurrentUserId`, `getAccessToken`, `getScopes`, `getDefaultScope`,
  `setContextValue`.
