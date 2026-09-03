-- Migration: add 'recall_used' to usage_events.event_type
--
-- Purpose:
--   The recall usefulness signal: a recalled memory that was actually USED (not just
--   surfaced). Emitted in-band when a `remember` supersedes/derives from a
--   recalled id, and out-of-band by the watcher's usefulness judge. Both write
--   one `recall_used` row; `metadata = {mem_id, source, useful, confidence?}`.
--   Widen the append-only stream's event_type vocabulary to admit it.
--
-- Affected objects:
--   - constraint: public.usage_events_event_type_check (drop + recreate with the
--     new value). Additive: no existing row changes, no data rewrite.
--
-- Special considerations:
--   - The append-only stream's content-free invariant is preserved: metadata
--     carries only ids/flags, never memory content.
--   - Deny-all RLS and service_role-only grants are unchanged.

set search_path = public;

alter table public.usage_events
  drop constraint usage_events_event_type_check;

alter table public.usage_events
  add constraint usage_events_event_type_check
  check (
    event_type in (
      'llm_extraction',
      'embedding',
      'mcp_tool_call',
      'ingest_chunk',
      'session_briefing',
      'recall_used'
    )
  );
