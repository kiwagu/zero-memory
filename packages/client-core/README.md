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
  `renderOpenLoopsSection` renders the visible block newest first, with
  staleness badges and an "and N more" counter, inside a character budget — a
  loop too long to fit whole becomes a one-line stub rather than ending the
  section (phrased as recorded data, never as imperatives).
- `standing-rules.logic.ts` — presentation of the briefing's `rules` section
  (the owner's promoted standing rules): `splitStandingRules` drains them out
  of a payload, `mergeStandingRules` unions overlapping briefings by text
  (keeping the pin), and `renderStandingRulesSection` renders the visible
  block. Unlike open loops, these are phrased as BINDING instructions — that
  is what the owner promoted them for — and pinned rules lead the list,
  marked, because the pin guarantees they reach the delivered set. Given a
  ceiling, the block keeps pinned rules whole even past it, carries the others
  whole while they fit and by headline (`ruleHeadline`) after, and says so.
  This is the full-text channel for every client; MCP `instructions` also
  inline rules for uncapped clients, while known capped clients only receive
  the router and inventory.
- `work-section.logic.ts` — `renderBoardSummary(work)`: the project board's
  lines in a briefing (the card bound to this conversation with its reason,
  active/waiting counts, the first few cards), phrased as declared state, never
  as instructions. `splitOpenLoops` drains the server's `work` field out of the
  pack alongside the loops, and the watcher renders both as ONE work section.
- `brief-budget.logic.ts` — fitting a briefing into the hook channel, whose
  client spills anything past ~10,000 characters to a file and shows only a
  preview: `resolveHookBudgetChars` (default 9,000), `planSectionBudgets`
  (the split decided before rendering — project line first, a floor held for
  the work in progress whenever there is any, the rules' ceiling from the
  rest),
  `renderPackWithinBudget` (whole memories while they fit, then one-line
  stubs) and `composeWithinBudget` (strict priority order, naming whatever
  had to go).
- `brief-tail.logic.ts` — the queue for what the first briefing of an epoch
  could not fit: `planTailChunk(tail, budgetChars)` sends the head of the
  queue, framed as a continuation of the same briefing with a count of what
  is left and the moment the pack was taken, and falls back to a one-line
  stub when even that one memory does not fit the message's budget — so a
  single oversized memory cannot stall the rest of the queue behind it. The
  chunk never exceeds its budget: when not even the stub fits, it sends
  nothing and the queue waits whole. Returns null once the queue is empty.
  The queue drains in the server's own rank, never by relevance to the
  current message — the prompt never leaves the machine, so there is no
  such signal to rank by. `mergeBriefTail(queued, deliveredIds, leftovers)`
  settles the queue against a briefing that rendered a pack of its own: what
  it delivered whole leaves, what it left over joins after what was already
  queued, each memory once. Pure planning only; the queue lives in the
  session state (`@workspace/client-runtime`) and the watcher's per-message
  hook drains it.
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
