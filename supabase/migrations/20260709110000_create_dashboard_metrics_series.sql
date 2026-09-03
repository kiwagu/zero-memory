-- Migration: create dashboard_metrics_series RPC (value dashboard trend)
--
-- Purpose:
--   Daily time-series behind the value dashboard's activity chart: per-day
--   recall/build_context calls and agent-captured memories over the window.
--   Same security posture as dashboard_metrics — security definer to read the
--   deny-all usage_events, hard-filtered to the caller's usr_.
--
-- Affected objects:
--   - function: public.dashboard_metrics_series(integer) -> jsonb (array)
--
-- Special considerations:
--   - Gap-filled: a generate_series of days left-joins the counts, so days with
--     no activity come back as 0 (an honest flat line, not a missing point).
--   - Day buckets are aligned to the DB clock's calendar days (date_trunc).
--   - Guest (no profile) -> empty array.

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
        'captured', coalesce(c.n, 0)
      )
      order by d.day
    ),
    '[]'::jsonb
  )
  into v_result
  from days d
    left join recalls r on r.day = d.day
    left join captures c on c.day = d.day;

  return v_result;
end;
$$;

comment on function public.dashboard_metrics_series(integer) is
  'Daily activity series (recall calls + agent captures) for the authenticated '
  'caller over the last p_days days. security definer over the '
  'deny-all usage_events; hard-filtered to the caller''s usr_.';

revoke all on function public.dashboard_metrics_series(integer)
  from public, anon;
grant execute on function public.dashboard_metrics_series(integer)
  to authenticated;
