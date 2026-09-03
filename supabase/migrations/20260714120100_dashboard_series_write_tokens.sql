-- Migration: add per-day write_tokens to dashboard_metrics_series
--
-- Purpose:
--   The combined "Tokens saved" widget draws a sparkline per side. Read already
--   has saved_tokens/day; this adds write_tokens/day (char/4 estimate of
--   agent-captured memory content) so the write sparkline is real and symmetric
--   with the read one.
--
-- Affected objects:
--   - function: public.dashboard_metrics_series(integer) -> jsonb (+write_tokens/day)

set search_path = public;

create or replace function public.dashboard_metrics_series(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
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
      and e.agent_name is distinct from 'zm-web'
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
    select
      date_trunc('day', m.created_at) as day,
      count(*)::int as n,
      coalesce(sum(ceil(length(m.content) / 4.0)), 0) as write_tokens
    from public.memories m
    where m.owner_id = v_usr
      and m.author_kind = 'agent'
      and m.created_at >= v_from
    group by 1
  ),
  -- Per-day judge quality over recall_used events. Distinct memories per day
  -- so a repeated verdict on the same fact does not inflate a day's counts.
  quality as (
    select
      date_trunc('day', e.occurred_at) as day,
      count(distinct e.metadata ->> 'mem_id') filter (
        where e.metadata ? 'relevant'
      )::int as judged,
      count(distinct e.metadata ->> 'mem_id') filter (
        where (e.metadata ->> 'relevant')::boolean is true
      )::int as relevant,
      count(distinct e.metadata ->> 'mem_id') filter (
        where (e.metadata ->> 'useful')::boolean is true
          and (
            e.metadata ->> 'source' = 'in_band'
            or coalesce((e.metadata ->> 'confidence')::numeric, 0) >= 0.6
          )
      )::int as used
    from public.usage_events e
    where e.user_id = v_usr
      and e.event_type = 'recall_used'
      and e.occurred_at >= v_from
    group by 1
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'date', to_char(d.day, 'YYYY-MM-DD'),
        'recall_calls', coalesce(r.n, 0),
        'captured', coalesce(c.n, 0),
        'saved_tokens', coalesce(b.saved_tokens, 0),
        'write_tokens', coalesce(c.write_tokens, 0),
        'briefing_hits', coalesce(b.hits, 0),
        'briefing_total', coalesce(b.total, 0),
        'judged', coalesce(q.judged, 0),
        'relevant', coalesce(q.relevant, 0),
        'used', coalesce(q.used, 0)
      )
      order by d.day
    ),
    '[]'::jsonb
  )
  into v_result
  from days d
    left join recalls r on r.day = d.day
    left join briefings b on b.day = d.day
    left join captures c on c.day = d.day
    left join quality q on q.day = d.day;

  return v_result;
end;
$function$;
