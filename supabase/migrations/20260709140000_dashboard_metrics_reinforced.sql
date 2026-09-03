-- Migration: add the "reinforced recalls" proxy to dashboard_metrics (interim)
--
-- Purpose:
--   Interim usefulness proxy: of the caller's own facts surfaced by recall/
--   build_context in the window, how many kept coming back (surfaced in >= 2
--   distinct recall events). An honest proxy for "this fact keeps pulling
--   weight" — NOT a true "was used" signal (that is the recall_used event, the
--   in-band + judge usefulness channels). Owned-only, same privacy posture as
--   top_facts.
--
-- Affected objects:
--   - function: public.dashboard_metrics(integer) -> jsonb (+reinforced_num/den)

set search_path = public;

create or replace function public.dashboard_metrics(
  p_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_usr text := private.current_user_entity_id();
  v_since timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  v_recall_calls int := 0;
  v_briefing_hits int := 0;
  v_briefing_total int := 0;
  v_saved_tokens numeric := 0;
  v_captured int := 0;
  v_live_num int := 0;
  v_live_den int := 0;
  v_scope_coverage int := 0;
  v_reinforced_num int := 0;
  v_reinforced_den int := 0;
  v_top_facts jsonb := '[]'::jsonb;
begin
  if v_usr is null then
    return jsonb_build_object(
      'recall_calls', 0,
      'briefing_hits', 0,
      'briefing_total', 0,
      'saved_tokens', 0,
      'captured_while_working', 0,
      'live_share_num', 0,
      'live_share_den', 0,
      'scope_coverage', 0,
      'reinforced_num', 0,
      'reinforced_den', 0,
      'top_facts', '[]'::jsonb,
      'since', v_since
    );
  end if;

  select count(*)::int
  into v_recall_calls
  from public.usage_events e
  where e.user_id = v_usr
    and e.event_type = 'mcp_tool_call'
    and e.metadata ->> 'tool' in ('recall', 'build_context')
    and e.occurred_at >= v_since;

  select
    count(*) filter (where e.metadata ->> 'empty' = 'false')::int,
    count(*)::int,
    coalesce(sum(e.quantity), 0)
  into v_briefing_hits, v_briefing_total, v_saved_tokens
  from public.usage_events e
  where e.user_id = v_usr
    and e.event_type = 'session_briefing'
    and e.occurred_at >= v_since;

  select count(*)::int
  into v_captured
  from public.memories m
  where m.owner_id = v_usr
    and m.author_kind = 'agent'
    and m.created_at >= v_since;

  select
    count(*) filter (
      where m.invalidated_at is null and m.superseded_by is null
    )::int,
    count(*)::int,
    count(distinct m.scope)::int
  into v_live_num, v_live_den, v_scope_coverage
  from public.memories m
  where m.owner_id = v_usr;

  -- Reinforced-recall proxy (interim): distinct OWNED facts surfaced
  -- in the window (den) and those surfaced in >= 2 distinct recalls (num).
  select
    count(*) filter (where r.recalls >= 2)::int,
    count(*)::int
  into v_reinforced_num, v_reinforced_den
  from (
    select hit.mem_id, count(distinct e.id) as recalls
    from public.usage_events e
      cross join lateral jsonb_array_elements_text(
        e.metadata -> 'returned_ids'
      ) as hit(mem_id)
      join public.memories m
        on m.id = hit.mem_id and m.owner_id = v_usr
    where e.user_id = v_usr
      and e.event_type = 'mcp_tool_call'
      and e.metadata ? 'returned_ids'
      and e.occurred_at >= v_since
    group by hit.mem_id
  ) r;

  -- Top surfaced facts, OWNED ONLY (no foreign leak).
  select coalesce(jsonb_agg(f order by f.surfaced desc), '[]'::jsonb)
  into v_top_facts
  from (
    select
      hit.mem_id as id,
      count(*)::int as surfaced,
      m.content,
      m.kind
    from public.usage_events e
      cross join lateral jsonb_array_elements_text(
        e.metadata -> 'returned_ids'
      ) as hit(mem_id)
      join public.memories m
        on m.id = hit.mem_id and m.owner_id = v_usr
    where e.user_id = v_usr
      and e.event_type = 'mcp_tool_call'
      and e.metadata ? 'returned_ids'
      and e.occurred_at >= v_since
    group by hit.mem_id, m.content, m.kind
    order by surfaced desc
    limit 5
  ) f;

  return jsonb_build_object(
    'recall_calls', v_recall_calls,
    'briefing_hits', v_briefing_hits,
    'briefing_total', v_briefing_total,
    'saved_tokens', v_saved_tokens,
    'captured_while_working', v_captured,
    'live_share_num', v_live_num,
    'live_share_den', v_live_den,
    'scope_coverage', v_scope_coverage,
    'reinforced_num', v_reinforced_num,
    'reinforced_den', v_reinforced_den,
    'top_facts', v_top_facts,
    'since', v_since
  );
end;
$$;
