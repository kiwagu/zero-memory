-- Migration: add 'result_fit' to usage_events.event_type
--
-- Purpose:
--   A read tool's result has to fit what the client shows inline; past that
--   line the client saves it to a file the agent rarely reads. Each read
--   result is now held to a character budget, and an agent can report its
--   client's own limit (`max_chars`). A `result_fit` row records one such
--   event: a result that was cut or measured over its budget, or a call that
--   reported its limit. That is the feedback that shows how large results get
--   and where clients really draw their line.
--   metadata = {tool, reported, budget, source, chars, delivered, omitted,
--   clipped}: sizes and counts only.
--
-- Affected objects:
--   - the event_type check on public.usage_events (dropped and recreated with
--     the new value, now named usage_events_event_type_check). Additive: no
--     existing row changes, no data rewrite.
--
-- Special considerations:
--   - The check is found by what it constrains, not by name. The monthly
--     partitioning recreated the table while the old one still held the
--     original name, so Postgres named the new check itself and the name
--     is not the one the first migration gave it.
--   - On the partitioned parent the drop and the add reach every partition;
--     the add validates the rows already stored, which all pass.
--   - The append-only stream's content-free invariant is preserved: metadata
--     carries only names, sizes and counts, never memory content.
--   - Deny-all RLS and service_role-only grants are unchanged.

set search_path = public;

do $$
declare
  v_name text;
begin
  select c.conname
    into v_name
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.usage_events'::regclass
     and c.contype = 'c'
     and pg_catalog.pg_get_constraintdef(c.oid) like '%event_type%';
  if v_name is null then
    raise exception 'public.usage_events has no event_type check to widen';
  end if;
  execute format('alter table public.usage_events drop constraint %I', v_name);
end;
$$;

alter table public.usage_events
  add constraint usage_events_event_type_check
  check (
    event_type in (
      'llm_extraction',
      'embedding',
      'mcp_tool_call',
      'ingest_chunk',
      'session_briefing',
      'recall_used',
      'result_fit'
    )
  );
