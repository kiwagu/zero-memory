-- Migration: extend dashboard_metrics_series with briefing + saved-token columns
--
-- Purpose:
--   The value dashboard grows a "With ZM vs Without ZM" comparison, tile
--   sparklines, and a small-multiples row. Those need per-day saved tokens and
--   briefing hit/total alongside the existing recall/capture counts. Additive:
--   create-or-replace keeps the same signature, just returns richer day rows.
--
-- Affected objects:
--   - function: public.dashboard_metrics_series(integer) -> jsonb (array)
--
-- Special considerations:
--   - Same security posture (security definer, deny-all usage_events, caller
--     scoped). Same gap-fill via generate_series.

set search_path = public;

create or replace function public.dashboard_metrics_series(
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
  v_days integer := greatest(coalesce(p_days, 30), 1);
  v_from timestamptz := date_trunc('day', now())
    - make_interval(days => v_days - 1);
  v_result jsonb;
begin
  if v_usr is null then
    return '[]'::jsonb;
  end if;

  with days as (
    select generate_series(
      v_from,
      date_trunc('day', now()),
      interval '1 day'
    ) as day
  ),
  recalls as (
    select date_trunc('day', e.occurred_at) as day, count(*)::int as n
    from public.usage_events e
    where e.user_id = v_usr
      and e.event_type = 'mcp_tool_call'
      and e.metadata ->> 'tool' in ('recall', 'build_context')
      and e.occurred_at >= v_from
    group by 1
  ),
  briefings as (
    select
      date_trunc('day', e.occurred_at) as day,
      count(*) filter (where e.metadata ->> 'empty' = 'false')::int as hits,
      count(*)::int as total,
      coalesce(sum(e.quantity), 0) as saved_tokens
    from public.usage_events e
    where e.user_id = v_usr
      and e.event_type = 'session_briefing'
      and e.occurred_at >= v_from
    group by 1
  ),
  captures as (
    select date_trunc('day', m.created_at) as day, count(*)::int as n
    from public.memories m
    where m.owner_id = v_usr
      and m.author_kind = 'agent'
      and m.created_at >= v_from
    group by 1
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'date', to_char(d.day, 'YYYY-MM-DD'),
        'recall_calls', coalesce(r.n, 0),
        'captured', coalesce(c.n, 0),
        'saved_tokens', coalesce(b.saved_tokens, 0),
        'briefing_hits', coalesce(b.hits, 0),
        'briefing_total', coalesce(b.total, 0)
      )
      order by d.day
    ),
    '[]'::jsonb
  )
  into v_result
  from days d
    left join recalls r on r.day = d.day
    left join briefings b on b.day = d.day
    left join captures c on c.day = d.day;

  return v_result;
end;
$$;
