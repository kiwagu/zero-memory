-- Migration: session_receipt — per-session value counters for the receipt line
--
-- Purpose:
--   One narrow read for the end-of-session receipt ("captured N / fired M /
--   loops +A-B / ~T tokens saved"): everything a session produced SINCE a
--   client-supplied timestamp, computed from rows that already exist. No new
--   event types, no new tables — a new consumer of usage_events + memories.
--
-- Affected objects:
--   - function: public.session_receipt(timestamptz) -> jsonb
--
-- Special considerations:
--   - security definer + search_path='' (usage_events is deny-all; the
--     function keys every aggregate on private.current_user_entity_id(), so
--     a caller can only ever read their own counters).
--   - `fired` counts DISTINCT memories confirmed useful (in_band rows are
--     useful by construction; judge rows carry useful=true/false), so a fact
--     confirmed by both channels lands once.
--   - Loop counters read public.memories directly (owner rows only): created
--     = open-loop kinds born in the window, closed = invalidated in the
--     window (close_loop is ADD-only invalidation).
--   - `saved_tokens` sums the session_briefing token estimates in the window
--     — the existing "what the user would have re-typed" estimate, no new
--     accounting.

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
begin
  if v_usr is null or p_since is null then
    return jsonb_build_object(
      'fired', 0,
      'loops_created', 0,
      'loops_closed', 0,
      'saved_tokens', 0,
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

  return jsonb_build_object(
    'fired', v_fired,
    'loops_created', v_loops_created,
    'loops_closed', v_loops_closed,
    'saved_tokens', v_saved_tokens,
    'since', p_since
  );
end;
$$;

comment on function public.session_receipt(timestamptz) is
  'Per-session value counters for the end-of-session receipt: distinct '
  'recalled memories confirmed useful (recall_used), open loops created and '
  'closed, and the briefing saved-tokens estimate, all since the given '
  'timestamp. Security definer, keyed on private.current_user_entity_id() — '
  'callers only ever see their own counters.';

revoke all on function public.session_receipt(timestamptz)
  from public, anon;
grant execute on function public.session_receipt(timestamptz)
  to authenticated;
