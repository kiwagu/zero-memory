# @workspace/client-runtime

The **IO adapters** of the memory client: the two ports that touch the outside
world — the file-backed **state store** and the **MCP transport** (with OAuth).
Everything here does IO; the client-agnostic domain that decides _what_ to
persist or send lives in `@workspace/client-core` (zero IO, Node-portable).

Merged from the former `@workspace/client-state` and `@workspace/client-transport`.
They were split apart in the first extraction pass, but no consumer ever wants
one without the other: every hook-based client bundle (Claude Code, Cursor,
and Codex) drives state **and** transport together. Keeping them as one
runtime package removes a seam nothing exercised, while `@workspace/client-core`
stays a separate pure-domain package so the domain still cannot import IO. The
per-client differences (event map, output frame, transcript source) live in the
`@workspace/client-adapter-*` packages, which remain separate.

## What it holds

### State-store port (`$XDG_STATE_HOME/zero-memory/`)

- `task-brief.state.ts` — per-session briefing state (`session-briefs.json`):
  which `mem_` ids the session-start briefing injected (the dedup source),
  whether the session already got its one task briefing, the session-start
  stamp (`stampSessionStart`) that anchors the receipt window, and the CONTEXT
  EPOCH. The epoch is what makes "already delivered" honest across a long
  session: `stampSessionStart` takes the client's reason for the event and
  advances the epoch on a boundary (compaction, a cleared conversation),
  which re-arms both per-window one-shots — the task briefing, whose context
  the compaction also took, and the standing rules, recorded per epoch by
  `markRulesDelivered` only once they were actually emitted. Pruned to the
  newest 200 sessions. It also holds THIS conversation's thread token
  (`recordSessionThread` / `readSessionThread`), which is what the per-message
  `PROJECT: … · THREAD: …` line quotes. The token lives here, keyed by session
  id, for a reason worth stating: a repository routinely has several sessions
  open at once, so a token kept per repository is overwritten by whichever
  session briefed last and the others begin quoting a conversation that is not
  theirs. A session with no token of its own renders the project line alone.
- `project-scope.state.ts` — the resolved project scope per repo root
  (`project-scopes.json`): the client half of the project handshake, so a later
  session (and the offline briefing) opens with the trusted project identity
  before any server call. Scope only — conversation-grained state belongs with
  the session, above. Pruned to the newest 200 roots.
- `session-receipt.state.ts` — per-session receipt state
  (`session-receipts.json`): the ingest flow accumulates `memories_created`
  per session (`recordCapturedMemories`), the session-end flow claims the one
  receipt a session gets (`claimReceipt`). Pruned to the newest 200 sessions.
- `brief-cache.ts` — offline briefing cache (`brief-cache/<project>.json`):
  stores the last delivered briefing per project (`writeBriefCache`) and reads
  it back (`readBriefCache`) when the server is unreachable; entries older than
  the TTL (default 7d, from `@workspace/client-core`) are refused,
  `.zero-memory-ignore` projects are cleared (`clearBriefCache`). Read-only
  resilience — writes are never buffered offline. The OFFLINE header itself is
  rendered by `@workspace/client-core`.
- `offset-state.ts` — `OffsetState`: persisted per-file byte offsets
  (`watcher.json`) so a restarted transcript watcher resumes where it left off
  instead of re-ingesting whole transcripts.

### Ingest consent (shared policy)

- `project-consent.ts` — the per-project capture gate every client path shares
  (`ingestAllowed` / `projectIgnored` / `ingestMode`). Reads
  `~/.config/zero-memory/ingest.json` (`ZM_INGEST_CONFIG`) — one of
  `allowlist` / `denylist` of path globs, default `off` — and honors
  `.zero-memory-ignore` / `.zero-memory-allow` markers. Lives here (not in the
  watcher) so the Stop/`stop` hooks AND the watch daemon decide identically —
  a remote watch-mode client cannot ship an unconsented project's transcript.

### MCP-transport port (OAuth-authed streamable HTTP)

One place that knows the server URL, opens an authed MCP client, and wraps each
server tool as a typed call — so the domain and the per-client adapters never
touch the wire. Authentication is delegated to `@workspace/mcp-oauth-client`
(`createAuthedTransport`); a machine authorizes once via the watcher's `login`.

- `server-config.ts` — WHICH server this machine talks to, resolved once for
  every client path: `ZM_SERVER_URL` (a deliberate override, the only
  variable name) > the persisted `~/.config/zero-memory/config.json`
  (`{"serverUrl"}`, written by `persistServerUrl` — the installers and
  `login <url>`) > `ServerNotConfiguredError`. Deliberately NO default: an
  invented address either names our own network or a stranger's machine, and a
  wrong server that silently works is worse than an error naming the fix. Also
  `E2E_SERVER_URL` (the fixed, disposable sandbox).
- `ingest-client.ts` — `IngestClient` (the `ingest_conversation` tool; rebuilds
  its connection after any failure so the watcher survives server restarts).
- `brief-client.ts` — `callBuildContext` (the `build_context` tool).
- `receipt-client.ts` — `callSessionReceipt` (the `session_receipt` tool).
- `capture-client.ts` — `callRemember` (the `remember` tool).
- `import-client.ts` — `ImportClient` (the `import_memory` tool).

## Consumers

- `apps/watcher` — the shared executable composes this runtime with
  `@workspace/client-core` and the Claude, Cursor, or Codex adapter selected by
  each hook/transcript source.
- `plugins/zero-memory`, `plugins/zero-memory-cursor`, and
  `plugins/zero-memory-codex` — client wiring that invokes the shared runtime
  through the watcher binary.

## Testing

`bun run test` from the repo root (vitest via turbo), or `vitest run` in this
package.
