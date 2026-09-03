-- Migration: session_receipt gains `already_knew` (rediscovery avoided)
--
-- Purpose:
--   Extend the end-of-session receipt with the recall-gap value signal: how
--   many prior memories the session was ABOUT to rewrite blind but memory
--   surfaced in time. Post-hoc from rows that already exist —
--   remember now stamps the supersede candidates it surfaced onto its
--   mcp_tool_call as metadata.similar_ids; the
--   receipt counts the ones that (a) existed before the window and (b) no
--   recall/build_context in the window returned. No new event type, no table.
--
-- Affected objects:
--   - function: public.session_receipt(timestamptz) -> jsonb (drop-in replace,
--     one new jsonb key `already_knew`; existing keys unchanged).
--
-- Special considerations:
--   - Framed memory-positively: "already knew N", never agent blame. It is a
--     rediscovery the memory PREVENTED, surfaced to the writer.
--   - created_at < p_since is the "prior knowledge" test: a candidate written
--     earlier in the same session is not a rediscovery of pre-existing memory.
--   - Distinct prior memory ids (not remember-calls): "memory already held N
--     facts you were about to duplicate".
--   - security definer + search_path='' preserved; still keyed on
--     private.current_user_entity_id() so a caller only sees their own counters.

create or replace function public.session_receipt(
  p_since timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_usr text := private.current_user_entity_id();
  v_fired int := 0;
  v_loops_created int := 0;
  v_loops_closed int := 0;
  v_saved_tokens numeric := 0;
  v_already_knew int := 0;
begin
  if v_usr is null or p_since is null then
    return jsonb_build_object(
      'fired', 0,
      'loops_created', 0,
      'loops_closed', 0,
      'saved_tokens', 0,
      'already_knew', 0,
      'since', p_since
    );
  end if;

  -- Distinct recalled memories that were actually used in the window.
  select count(distinct e.metadata ->> 'mem_id')::int
  into v_fired
  from public.usage_events e
  where e.user_id = v_usr
    and e.event_type = 'recall_used'
    and (e.metadata ->> 'useful')::boolean
    and e.occurred_at >= p_since;

  -- Open loops born / closed in the window (owner rows only).
  select
    count(*) filter (where m.created_at >= p_since)::int,
    count(*) filter (where m.invalidated_at >= p_since)::int
  into v_loops_created, v_loops_closed
  from public.memories m
  where m.owner_id = v_usr
    and m.kind in ('task', 'open-question');

  -- Briefing token estimate delivered in the window (existing estimate).
  select coalesce(sum(e.quantity), 0)
  into v_saved_tokens
  from public.usage_events e
  where e.user_id = v_usr
    and e.event_type = 'session_briefing'
    and e.occurred_at >= p_since;

  -- Rediscovery avoided: prior memories a remember in the window surfaced as
  -- supersede candidates that no recall/build_context in the window returned.
  with surfaced as (
    select distinct sid as mem_id
    from public.usage_events e,
      lateral jsonb_array_elements_text(e.metadata -> 'similar_ids') sid
    where e.user_id = v_usr
      and e.event_type = 'mcp_tool_call'
      and e.metadata ->> 'tool' = 'remember'
      and e.metadata ? 'similar_ids'
      and e.occurred_at >= p_since
  ),
  recalled as (
    select distinct rid as mem_id
    from public.usage_events e,
      lateral jsonb_array_elements_text(e.metadata -> 'returned_ids') rid
    where e.user_id = v_usr
      and e.event_type = 'mcp_tool_call'
      and e.metadata ->> 'tool' in ('recall', 'build_context')
      and e.occurred_at >= p_since
  )
  select count(*)::int
  into v_already_knew
  from surfaced s
  join public.memories m on m.id = s.mem_id
  where m.owner_id = v_usr
    and m.created_at < p_since
    and not exists (
      select 1 from recalled r where r.mem_id = s.mem_id
    );

  return jsonb_build_object(
    'fired', v_fired,
    'loops_created', v_loops_created,
    'loops_closed', v_loops_closed,
    'saved_tokens', v_saved_tokens,
    'already_knew', v_already_knew,
    'since', p_since
  );
end;
$$;

comment on function public.session_receipt(timestamptz) is
  'Per-session value counters for the end-of-session receipt: distinct '
  'recalled memories confirmed useful (recall_used), open loops created and '
  'closed, the briefing saved-tokens estimate, and `already_knew` — prior '
  'memories a remember in the window surfaced as supersede candidates that no '
  'recall returned (rediscovery the memory prevented). All since the given '
  'timestamp. Security definer, keyed on private.current_user_entity_id() — '
  'callers only ever see their own counters.';

revoke all on function public.session_receipt(timestamptz)
  from public, anon;
grant execute on function public.session_receipt(timestamptz)
  to authenticated;
