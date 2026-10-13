# `@workspace/mcp`

The MCP adapter: builds the `zero-memory` MCP server that exposes the memory
tools and dispatches them through the CQRS buses. Transport-agnostic — stdio
and streamable HTTP are supplied by the caller.

## Role in the architecture

Interface adapter (protocol layer). Depends on the MCP SDK,
`@workspace/contracts` (tool schemas), `@workspace/commands` /
`@workspace/queries` (messages), and `@workspace/cqrs` (bus interfaces). The
app host connects the returned server to a transport.

## Key exports

- `buildMcpServer(deps)` — registers the complete tool surface:
  - write/ingest: `remember`, `ingest_conversation`, `import_memory`;
  - retrieve/brief: `recall`, `build_context`, `entities`, `describe_scope`;
  - graph/share: `link`, `share`;
  - lifecycle: `forget`, `restore_memory`, `close_loop`;
  - hygiene: `scan_hygiene`, `list_conflicts`, `get_conflict`,
    `resolve_conflict`, `resolve_conflicts`;
  - rules/quality: `promote_rule`, `benchmark_memory`;
  - operations: `session_receipt`, `export_metrics`, `export_memories`.
    There is deliberately no account-deletion tool: an agent acts as the
    person, so erasing the account is left to the person in the dashboard.
    Read-tool results carry a reinforcement footer; `build_context` additionally
    renders applicable standing rules and active open loops.
- `McpServerDeps` — `commandBus`, `queryBus`, `runInToolContext` (wraps every
  tool call in an authenticated execution context), optional `sessionScope`
  and metering hooks (including `onWriteRefused`, fired with the stable reason
  code when a write named no usable target), and optional `workClaims`.
- `IWorkClaims` / `InProcessWorkClaims` / `workClaimKey` — one queued or
  running background scan or benchmark per owner. The default holds the
  claims in this process; a deployment whose background work runs on a worker
  of its own supplies shared claims, and the worker releases them. Each claim
  hands out a `WorkClaimToken` (a `wcl_` entity id, `newWorkClaimToken`,
  checked with `workClaimTokenSchema`) that travels with the work; only its
  holder may end the claim.
- `McpSessionScope` — how a session learns where its scope-less writes go:
  `attachProjectScope` / `currentProjectScope`. **First attach wins.** A
  `project_hint` that resolves attaches the session only while it has no
  project; a later hint naming a DIFFERENT project pins that read alone, and
  the result says so. Reading another project is a first-class move — its
  decisions are often the answer here — but it must never redirect where this
  session writes; a deliberate write elsewhere names its target on the write.
- `toolError(code, message, details?)` / `toolErrorFromThrown(error)` — the
  only way a tool reports failure: `isError` plus the shared taxonomy body as
  the first text block, so a client branches on `error.code` instead of on
  prose. A thrown value carrying a taxonomy code keeps its class; anything
  else is `internal`.
- `CONSENT_AREAS` — every tool, grouped into the areas the dashboard's consent
  screen names when a person allows an agent. Its spec fails when a tool has
  no area, or an area has no copy in the web catalogs or no line on the
  consent page, so the screen never describes less than an agent can do.
- `CONTRACT_CAPABILITY_KEY` — the `capabilities.experimental` key under which
  the initialize handshake announces `CONTRACT_VERSION`. It rides a capability
  rather than `serverInfo` (the SDK client drops unknown keys there) or
  `instructions` (hard-capped by clients, and already spent on the router).
- `composeInstructions(...)` — builds client-aware MCP instructions. Known
  capped clients (`claude-code`) receive a compact router and rule inventory;
  other clients receive applicable rule texts inline, pinned first. Full rules
  remain available through `build_context.rules[]`.
