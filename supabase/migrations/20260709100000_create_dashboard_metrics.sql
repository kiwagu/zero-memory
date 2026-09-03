-- Migration: create dashboard_metrics RPC (value dashboard)
--
-- Purpose:
--   One security-definer aggregator behind the "value dashboard". The web
--   app runs under an authenticated JWT that cannot see public.usage_events
--   (deny-all). This function reads usage_events + memories as its
--   owner and returns ONLY the caller's rollups, scoped by the same auth.uid ->
--   usr_ translation the memories RLS uses (private.current_user_entity_id()).
--
-- Affected objects:
--   - function: public.dashboard_metrics(timestamptz) -> jsonb
--
-- Special considerations:
--   - security definer + search_path = '': the function bypasses the
--     usage_events deny-all on purpose, so every read is hard-filtered to
--     user_id = v_usr (usage_events) / owner_id = v_usr (memories). It never
--     returns another user's data even though it can read the whole table.
--   - Foreign memories surfaced in a shared scope appear in top_facts by id
--     only: the memories join is owner-scoped, so content/kind stay null for
--     rows the caller does not own (RLS-equivalent content hiding).
--   - stable: reads only; the planner may hoist it. Guest (no profile) -> zeros.

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
  -- Window computed from the DB's own clock (no client/server skew); the caller
  -- picks a period length, not an absolute instant.
  v_since timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  v_recall_calls int := 0;
  v_briefing_hits int := 0;
  v_briefing_total int := 0;
  v_saved_tokens numeric := 0;
  v_captured int := 0;
  v_live_num int := 0;
  v_live_den int := 0;
  v_scope_coverage int := 0;
  v_top_facts jsonb := '[]'::jsonb;
begin
  -- Guest / no profile: nothing to attribute, return an all-zero shape so the
  -- UI renders its empty state rather than erroring.
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
      'top_facts', '[]'::jsonb,
      'since', v_since
    );
  end if;

  -- Volume of recall / build_context calls in the window.
  select count(*)::int
  into v_recall_calls
  from public.usage_events e
  where e.user_id = v_usr
    and e.event_type = 'mcp_tool_call'
    and e.metadata ->> 'tool' in ('recall', 'build_context')
    and e.occurred_at >= v_since;

  -- Briefing hit-rate numerator/denominator + saved-token estimate. The UI
  -- divides hits/total so a zero denominator shows "no data", not a crash.
  select
    count(*) filter (where e.metadata ->> 'empty' = 'false')::int,
    count(*)::int,
    coalesce(sum(e.quantity), 0)
  into v_briefing_hits, v_briefing_total, v_saved_tokens
  from public.usage_events e
  where e.user_id = v_usr
    and e.event_type = 'session_briefing'
    and e.occurred_at >= v_since;

  -- "Captured while you just worked": memories the agent/watcher wrote in the
  -- window (zero-effort proof of value).
  select count(*)::int
  into v_captured
  from public.memories m
  where m.owner_id = v_usr
    and m.author_kind = 'agent'
    and m.created_at >= v_since;

  -- Trust coefficients (all-time, not windowed): share of the caller's
  -- memories still live (not invalidated, not superseded) + scope coverage.
  select
    count(*) filter (
      where m.invalidated_at is null and m.superseded_by is null
    )::int,
    count(*)::int,
    count(distinct m.scope)::int
  into v_live_num, v_live_den, v_scope_coverage
  from public.memories m
  where m.owner_id = v_usr;

  -- Top surfaced facts: unnest returned_ids from the caller's recall /
  -- build_context calls, rank by surfaced-count. Content only for owned rows.
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
      left join public.memories m
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
    'top_facts', v_top_facts,
    'since', v_since
  );
end;
$$;

comment on function public.dashboard_metrics(integer) is
  'Value-dashboard rollups for the authenticated caller only over '
  'the last p_days days. security definer to read the deny-all usage_events; '
  'hard-filtered to the caller''s usr_ id.';

-- REST-callable by signed-in users only; the function self-scopes to the JWT.
revoke all on function public.dashboard_metrics(integer)
  from public, anon;
grant execute on function public.dashboard_metrics(integer)
  to authenticated;
