-- Migration: corpus-age vitrine data in dashboard_metrics
--
-- Purpose:
--   Ranking-time decay is invisible without observability: the owner cannot
--   see how much of the live corpus has aged past its kind's half-life (and
--   is therefore ranked at less than half strength). Extend dashboard_metrics
--   with a whole-corpus age slice (like the inventory numbers, not windowed):
--     - corpus_median_age_days  — median age of live memories
--     - faded_num / faded_den   — live memories older than their kind's
--                                 half-life (ranking weight < 0.5) / all live
--     - age_buckets             — live memories by age bucket
--                                 (d7 / d30 / d90 / d365 / older), all five
--                                 keys always present
--
-- Affected objects:
--   - function: public.dashboard_metrics(integer) -> jsonb
--     (+corpus_median_age_days, +faded_num, +faded_den, +age_buckets)
--
-- Special considerations:
--   - "Live" here = invalidated_at is null — the exact population the search
--     ranking sees (live_share_num additionally excludes superseded rows; the
--     age slice deliberately matches the ranking candidates instead).
--   - Half-life per kind comes from public.ranking_config (single source);
--     kinds without a row use the same 365-day fallback as search_memories.

set search_path = public;

create or replace function public.dashboard_metrics(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_usr text := private.current_user_entity_id();
  v_since timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  v_recall_calls int := 0;
  v_briefing_hits int := 0;
  v_briefing_total int := 0;
  v_saved_tokens numeric := 0;
  v_write_tokens numeric := 0;
  v_captured int := 0;
  v_live_num int := 0;
  v_live_den int := 0;
  v_scope_coverage int := 0;
  v_reinforced_num int := 0;
  v_reinforced_den int := 0;
  v_usefulness_num int := 0;
  v_usefulness_den int := 0;
  v_entities_total int := 0;
  v_memories_24h int := 0;
  v_entities_24h int := 0;
  v_last_captured_at timestamptz := null;
  v_empty_recall_num int := 0;
  v_empty_recall_den int := 0;
  v_stale_median_days numeric := null;
  v_stale_over_90_num int := 0;
  v_recall_used_events int := 0;
  v_precision_num int := 0;
  v_precision_den int := 0;
  v_top_facts jsonb := '[]'::jsonb;
  v_corpus_median_age_days numeric := null;
  v_faded_num int := 0;
  v_faded_den int := 0;
  v_age_buckets jsonb := '[]'::jsonb;
begin
  if v_usr is null then
    return jsonb_build_object(
      'recall_calls', 0,
      'briefing_hits', 0,
      'briefing_total', 0,
      'saved_tokens', 0,
      'write_tokens_saved', 0,
      'captured_while_working', 0,
      'live_share_num', 0,
      'live_share_den', 0,
      'scope_coverage', 0,
      'reinforced_num', 0,
      'reinforced_den', 0,
      'usefulness_num', 0,
      'usefulness_den', 0,
      'entities_total', 0,
      'memories_24h', 0,
      'entities_24h', 0,
      'last_captured_at', null,
      'empty_recall_num', 0,
      'empty_recall_den', 0,
      'stale_median_days', null,
      'stale_over_90_num', 0,
      'recall_used_events', 0,
      'precision_num', 0,
      'precision_den', 0,
      'top_facts', '[]'::jsonb,
      'corpus_median_age_days', null,
      'faded_num', 0,
      'faded_den', 0,
      'age_buckets', '[]'::jsonb,
      'since', v_since
    );
  end if;

  select count(*)::int
  into v_recall_calls
  from public.usage_events e
  where e.user_id = v_usr
    and e.event_type = 'mcp_tool_call'
    and e.agent_name is distinct from 'zm-web'
    and e.metadata ->> 'tool' in ('recall', 'build_context')
    and e.occurred_at >= v_since;

  -- Empty-recall rate: only result-attributed calls (they always carry
  -- returned_ids, even when empty) — den; of those, [] surfaced nothing — num.
  select
    count(*) filter (
      where jsonb_array_length(e.metadata -> 'returned_ids') = 0
    )::int,
    count(*)::int
  into v_empty_recall_num, v_empty_recall_den
  from public.usage_events e
  where e.user_id = v_usr
    and e.event_type = 'mcp_tool_call'
    and e.agent_name is distinct from 'zm-web'
    and e.metadata ? 'returned_ids'
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

  -- Usefulness-signal coverage: every recall_used event in the window,
  -- regardless of verdict — the UI phase-switches the quality tile on this.
  select count(*)::int
  into v_recall_used_events
  from public.usage_events e
  where e.user_id = v_usr
    and e.event_type = 'recall_used'
    and e.occurred_at >= v_since;

  -- Context precision over JUDGED facts only: den = distinct memories with a
  -- relevance verdict in the window; num = those judged relevant at least
  -- once. Judged-only denominator keeps a sparse (or absent) watcher judge
  -- from reading as bad precision.
  select
    count(distinct e.metadata ->> 'mem_id') filter (
      where (e.metadata ->> 'relevant')::boolean is true
    )::int,
    count(distinct e.metadata ->> 'mem_id')::int
  into v_precision_num, v_precision_den
  from public.usage_events e
  where e.user_id = v_usr
    and e.event_type = 'recall_used'
    and e.metadata ? 'relevant'
    and e.occurred_at >= v_since;

  -- Captured facts + Write-side token size: agent-authored memories written in
  -- the window (watcher + in-band agent remember). Write tokens = char/4
  -- estimate of their content — the tokens you did not type.
  select
    count(*)::int,
    coalesce(sum(ceil(length(m.content) / 4.0)), 0)
  into v_captured, v_write_tokens
  from public.memories m
  where m.owner_id = v_usr
    and m.author_kind = 'agent'
    and m.created_at >= v_since;

  -- All-time inventory + 24h growth + freshness stamp (one pass).
  select
    count(*) filter (
      where m.invalidated_at is null and m.superseded_by is null
    )::int,
    count(*)::int,
    count(distinct m.scope)::int,
    count(*) filter (
      where m.created_at >= now() - interval '24 hours'
    )::int,
    max(m.created_at)
  into v_live_num, v_live_den, v_scope_coverage, v_memories_24h,
    v_last_captured_at
  from public.memories m
  where m.owner_id = v_usr;

  select
    count(*)::int,
    count(*) filter (
      where n.created_at >= now() - interval '24 hours'
    )::int
  into v_entities_total, v_entities_24h
  from public.entities n
  where n.created_by = v_usr;

  -- Corpus age slice over the RANKING population (invalidated_at is null):
  -- median age, and the share aged past its kind's half-life — i.e. ranked at
  -- less than half strength by the decay multiplier. Half-lives come from
  -- ranking_config; kinds without a row use the search fallback (365 days).
  select
    percentile_cont(0.5) within group (order by age.days),
    count(*) filter (where age.days > age.half_life)::int,
    count(*)::int
  into v_corpus_median_age_days, v_faded_num, v_faded_den
  from (
    select
      extract(epoch from (now() - m.created_at)) / 86400.0 as days,
      coalesce(cfg.half_life_days, 365.0) as half_life
    from public.memories m
    left join public.ranking_config cfg on cfg.kind = m.kind
    where m.owner_id = v_usr
      and m.invalidated_at is null
  ) age;

  -- Age distribution of the same population, fixed buckets. All five keys are
  -- always present (zero counts included) so the UI never guesses the axis.
  select coalesce(
    jsonb_agg(
      jsonb_build_object('key', d.key, 'count', coalesce(c.cnt, 0))
      order by d.ord
    ),
    '[]'::jsonb
  )
  into v_age_buckets
  from (
    values ('d7', 1), ('d30', 2), ('d90', 3), ('d365', 4), ('older', 5)
  ) as d (key, ord)
  left join (
    select
      case
        when m.created_at >= now() - interval '7 days' then 'd7'
        when m.created_at >= now() - interval '30 days' then 'd30'
        when m.created_at >= now() - interval '90 days' then 'd90'
        when m.created_at >= now() - interval '365 days' then 'd365'
        else 'older'
      end as key,
      count(*)::int as cnt
    from public.memories m
    where m.owner_id = v_usr
      and m.invalidated_at is null
    group by 1
  ) as c on c.key = d.key;

  -- One scan over the distinct OWNED facts surfaced in the window feeds both
  -- the reinforced proxy (>= 2 distinct recalls) and the staleness stats
  -- (median age in days; count older than 90 days).
  select
    count(*) filter (where r.recalls >= 2)::int,
    count(*)::int,
    percentile_cont(0.5) within group (
      order by extract(epoch from (now() - r.created_at)) / 86400.0
    ),
    count(*) filter (
      where r.created_at < now() - interval '90 days'
    )::int
  into v_reinforced_num, v_reinforced_den, v_stale_median_days,
    v_stale_over_90_num
  from (
    select hit.mem_id, count(distinct e.id) as recalls, m.created_at
    from public.usage_events e
      cross join lateral jsonb_array_elements_text(
        e.metadata -> 'returned_ids'
      ) as hit(mem_id)
      join public.memories m
        on m.id = hit.mem_id and m.owner_id = v_usr
    where e.user_id = v_usr
      and e.event_type = 'mcp_tool_call'
      and e.agent_name is distinct from 'zm-web'
      and e.metadata ? 'returned_ids'
      and e.occurred_at >= v_since
    group by hit.mem_id, m.created_at
  ) r;

  -- Usefulness hit-rate (in-band + judge): den = distinct OWNED facts surfaced in
  -- the window; num = those among them with a useful recall_used event in the
  -- window. Intersected with the surfaced set so the rate is bounded to <=100%.
  with surfaced as (
    select distinct hit.mem_id
    from public.usage_events e
      cross join lateral jsonb_array_elements_text(
        e.metadata -> 'returned_ids'
      ) as hit(mem_id)
      join public.memories m
        on m.id = hit.mem_id and m.owner_id = v_usr
    where e.user_id = v_usr
      and e.event_type = 'mcp_tool_call'
      and e.agent_name is distinct from 'zm-web'
      and e.metadata ? 'returned_ids'
      and e.occurred_at >= v_since
  ),
  used as (
    select distinct e.metadata ->> 'mem_id' as mem_id
    from public.usage_events e
    where e.user_id = v_usr
      and e.event_type = 'recall_used'
      and (e.metadata ->> 'useful')::boolean is true
      and (
        e.metadata ->> 'source' = 'in_band'
        or coalesce((e.metadata ->> 'confidence')::numeric, 0) >= 0.6
      )
      and e.occurred_at >= v_since
  )
  select
    count(*) filter (where used.mem_id is not null)::int,
    count(*)::int
  into v_usefulness_num, v_usefulness_den
  from surfaced
  left join used on used.mem_id = surfaced.mem_id;

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
      and e.agent_name is distinct from 'zm-web'
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
    'write_tokens_saved', v_write_tokens,
    'captured_while_working', v_captured,
    'live_share_num', v_live_num,
    'live_share_den', v_live_den,
    'scope_coverage', v_scope_coverage,
    'reinforced_num', v_reinforced_num,
    'reinforced_den', v_reinforced_den,
    'usefulness_num', v_usefulness_num,
    'usefulness_den', v_usefulness_den,
    'entities_total', v_entities_total,
    'memories_24h', v_memories_24h,
    'entities_24h', v_entities_24h,
    'last_captured_at', v_last_captured_at,
    'empty_recall_num', v_empty_recall_num,
    'empty_recall_den', v_empty_recall_den,
    'stale_median_days', v_stale_median_days,
    'stale_over_90_num', v_stale_over_90_num,
    'recall_used_events', v_recall_used_events,
    'precision_num', v_precision_num,
    'precision_den', v_precision_den,
    'top_facts', v_top_facts,
    'corpus_median_age_days', v_corpus_median_age_days,
    'faded_num', v_faded_num,
    'faded_den', v_faded_den,
    'age_buckets', v_age_buckets,
    'since', v_since
  );
end;
$function$;
