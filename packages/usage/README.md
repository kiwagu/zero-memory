# `@workspace/usage`

Metering + product-analytics port: record one usage event per metered unit of
work without storing memory content.

## Role in the architecture

Domain-layer port (shared kernel for metering). Depends only on
`@workspace/di` and `@workspace/logger`. The emit sites — extraction,
embedding, ingest, and the MCP dispatcher — depend on this package to record
usage without knowing how it is stored. The Supabase adapter
(`@workspace/persistence` → `SupabaseUsageRecorder`) writes to the deny-all
`public.usage_events` under the service role, stamping the actor (`usr_`) and
request id from the ambient context.

## Key exports

- `IUsageRecorder` / `USAGE_RECORDER` / `injectUsageRecorder()` — the port, its
  DI token, and inject decorator.
- `recordUsage(recorder, event)` — fire-and-forget emit: deliberately not
  awaited and never throws into the caller (a synchronous throw or a rejected
  write is logged at warn and dropped), so metering can never break — or slow —
  the operation it measures.
- `UsageEvent`, `UsageEventType`, `UsageUnit` — the event shape and enums
  (`llm_extraction` / `embedding` / `mcp_tool_call` / `ingest_chunk` /
  `session_briefing` / `recall_used`; unit `count` / `tokens`).

## Emit points

| Event              | Where                                   | Quantity           |
| ------------------ | --------------------------------------- | ------------------ |
| `llm_extraction`   | `LlmExtractor` (+ judges/translation/…) | total tokens       |
| `embedding`        | `E5SmallEmbeddingService`               | texts in the batch |
| `ingest_chunk`     | `IngestService` (per accepted chunk)    | 1                  |
| `mcp_tool_call`    | MCP dispatcher (composition-level hook) | 1                  |
| `session_briefing` | `build_context` briefing result         | estimated tokens   |
| `recall_used`      | usefulness evidence                     | 1                  |

Payloads carry counters and identifiers (tool name, token split, model,
returned ids), never memory content. The deliberate exception is the user's
own recall/topic text in `query`, truncated to 200 characters so the activity
feed can explain a search. It is stored exactly as it was sent, which is also
exactly what was searched.
