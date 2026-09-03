# @workspace/client-core

Client-agnostic **domain** of the memory client: pure, unit-tested briefing and
receipt logic with **zero IO**. It holds no knowledge of any editor — no hook
protocol, no transcript format, no file paths. The shipped Claude, Cursor, and
Codex adapters wire these decisions to their surfaces; the state-store and
transport IO lives in `@workspace/client-runtime`. VS Code remains an
instruction-only integration until it exposes stable lifecycle/transcript
APIs.

Extracted from the former `@workspace/claude-hooks` so every client bundle can
consume the same core (see the R3 client-adapters direction).

## What it holds

- `task-brief.logic.ts` — decisions for the task-brief-on-prompt flow:
  - `isSubstantivePrompt(prompt, ackWords?)` — length gate (≥30 chars),
    slash-command skip, and an acknowledgement stop-list so confirmations never
    trigger a briefing. The defaults are English only (no language bias in the
    core); `resolveAcknowledgementWords(extra)` merges in the operator's
    configured words (the adapter reads them from `ZM_ACK_WORDS`);
  - `parseBriefingPack` / `filterBriefingPack` / `isEmptyPack` — parse a
    `build_context` payload and drop memories another briefing already injected;
  - `packMemoryIds(payload)` — best-effort `mem_` id extraction (never throws),
    used by the session-start flow to record what it injected.
- `open-loops.logic.ts` — presentation of the briefing's `open_loops` section
  (active `task` / `open-question` memories): `splitOpenLoops` drains the loops
  out of a payload, `mergeOpenLoops` unions overlapping briefings by id, and
  `renderOpenLoopsSection` renders the visible block with staleness badges and
  an "and N more" counter (phrased as recorded data, never as imperatives).
- `standing-rules.logic.ts` — presentation of the briefing's `rules` section
  (the owner's promoted standing rules): `splitStandingRules` drains them out
  of a payload, `mergeStandingRules` unions overlapping briefings by text
  (keeping the pin), and `renderStandingRulesSection` renders the visible
  block. Unlike open loops, these are phrased as BINDING instructions — that
  is what the owner promoted them for — and pinned rules lead the list,
  marked, because the pin guarantees they reach the delivered set. This is the
  uncapped full-text channel for every client; MCP `instructions` also inline
  rules for uncapped clients, while known capped clients only receive the
  router and inventory.
- `context-epoch.logic.ts` — what "the session has already been told this"
  means once a conversation outlives its context window. A briefing writes
  into the transcript, and compaction is exactly what discards the transcript,
  so deliveries are scoped to a WINDOW rather than to a session:
  `startsNewEpoch(source)` reads the client's own reason for a session event
  (`compact` / `clear` end a window; `startup` has no previous one and
  `resume` replays the transcript, so neither does), and
  `rulesNeedDelivery({epoch, rulesEpoch})` answers whether this window has
  actually carried the standing rules yet. Deliberately keyed on recorded
  DELIVERY, not on an attempt: a briefing that failed records nothing, so the
  rules still arrive from the next hook. A client that reports no reason never
  opens an epoch and keeps the previous repeat-every-time behaviour.
- `compaction-anchor.logic.ts` — `renderCompactionAnchor({scope, thread, loops,
total})`: the text a client emits just BEFORE its context is compacted, or
  null when it has nothing worth anchoring. Written as an instruction to the
  model producing the summary, because that is who receives it — a
  pre-compaction hook's output reaches the summarizer rather than the surviving
  context, so text shaped as content survives only if it happens to be echoed.
  Carries only what the transcript cannot rebuild once condensed (project,
  thread, open loops) and stays inside a small budget: it competes for attention
  with the whole conversation being summarized, and the memory pack is reloaded
  by the briefing that fires just after the boundary anyway. Loops stay RECORDED
  DATA here as everywhere else — the single imperative is about summary
  fidelity, never about which work to pick up.
- `session-receipt.logic.ts` — `formatReceiptLine(counters)`: the one
  chat-visible end-of-session receipt line ("captured N · M recalled facts
  fired · loops +A/−B · ~T tokens saved (est.)"), or null for silence when the
  session produced nothing.
- `recall-tools.logic.ts` — what every adapter needs in order to feed the
  usefulness judge, kept in one place because each client spells it
  differently: `isRecallTool(name)` / `toolBaseName(name)` recognize a recall
  or `build_context` call under any mount (Claude Code records
  `mcp__zero-memory__recall`, Codex and Cursor record a bare `recall` and keep
  the mount in a field of their own — comparing the last `__` segment covers
  all of them), and `collectMemoryIds(payload)` pulls the `mem_` ids out of a
  stringified result using the canonical entity-id char class. The
  envelope-walking that finds those names and payloads stays in each adapter;
  only the judgement is domain.
- `offline-briefing.ts` — the `BriefCacheEntry` shape, the default TTL, and
  `renderOfflineBriefing(entry)` (the explicit OFFLINE staleness header ahead
  of a cached briefing). The file-backed cache IO that produces these entries
  lives in `@workspace/client-runtime`.

## Consumers

- `apps/watcher` — composes this domain with the runtime and the selected
  Claude, Cursor, or Codex adapter for briefing, receipt, ingest, and watch
  commands.

## Testing

`bun run test` from the repo root (vitest via turbo), or `vitest run` in this
package.
