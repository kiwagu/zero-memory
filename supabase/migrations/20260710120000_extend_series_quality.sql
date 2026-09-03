-- Migration: extend dashboard_metrics_series with per-day judge-quality counts
--
-- Purpose:
--   The judge already scores live traffic continuously — every watcher ingest
--   emits recall_used verdicts (useful + relevant, ADR'd two-axis judge). What
--   was missing is the TIME SERIES: quality trends per day, chartable on the
--   dashboard and exportable for offline analysis (the series is deliberately
--   a clean, stable-keyed JSON array). Adds three per-day counts:
--     judged   — distinct memories that received a relevance verdict that day;
--     relevant — of those, judged relevant at least once;
--     used     — distinct memories with a qualifying useful verdict that day
--                (in-band always counts; judge verdicts at confidence >= 0.6,
--                mirroring dashboard_metrics' usefulness rule).
--   All zeros when no watcher is connected — the watcher is optional; nothing
--   here assumes one exists. Additive: same signature, richer day rows.
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
$$;
