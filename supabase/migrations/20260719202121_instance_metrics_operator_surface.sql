-- Migration: operator surface — instance_metrics over one metric definition
--
-- Purpose:
--   Give an instance operator the aggregate of the SAME value metrics the
--   personal dashboard shows, summed across every user of the instance —
--   without a second set of definitions that could drift from the vitrine.
--
--   The move that makes that honest: the per-owner body of dashboard_metrics
--   is lifted into ONE function, private.dashboard_metrics_core, parameterised
--   by owner. Passed a single owner it reproduces the vitrine exactly; passed
--   NULL it computes over the whole instance. dashboard_metrics becomes a thin
--   wrapper (owner from the JWT, plus the content-bearing top_facts), and
--   instance_metrics is the same core with NULL plus operator-only figures
--   (seats, the hygiene queue, the latest eval runs).
--
--   Because the medians and the reinforced/usefulness passes are computed over
--   the population the filter selects — not summed from per-user results — they
--   are correct for one owner and for all owners alike. A median cannot be
--   averaged back together from per-user medians; here it never has to be.
--
-- Affected objects:
--   - function private.dashboard_metrics_core(text, timestamptz) (new — THE definition)
--   - function public.dashboard_metrics(integer) (replaced: thin wrapper, same output)
--   - function public.instance_metrics(integer) (new, service_role only)
--   - function public.instance_metrics_series(integer) (new, service_role only)
--
-- Special considerations:
--   - CONTENT-FREE operator surface: instance_metrics carries counters, scores
--     and distributions only. top_facts (memory content) stays in the vitrine
--     wrapper and is never in core, so it cannot reach the operator surface.
--     scope_coverage is a COUNT of distinct scopes, not their names.
--   - A NULL owner means "the whole instance", which is different from "no
--     authenticated user". The wrapper MUST null-guard the JWT owner BEFORE
--     calling core, or an anonymous dashboard_metrics call would return the
--     instance aggregate. The guard is the security boundary here.
--   - instance_metrics(_series) are service_role only — deny-all to end users
--     like every operational surface. The vitrine stays per-user under RLS.

set search_path = public;

-- 1. the single definition -----------------------------------------------------

-- Every content-free per-owner metric the vitrine computes, lifted verbatim and
-- parameterised on the owner. p_owner NULL = the whole instance. The owner
-- filters are written `(p_owner is null or X = p_owner)`; passed a concrete
-- owner each collapses to the vitrine's original `X = <owner>`, so the vitrine
-- is byte-for-byte unchanged.
create or replace function private.dashboard_metrics_core(
  p_owner text,
  p_since timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
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
  v_corpus_median_age_days numeric := null;
  v_faded_num int := 0;
  v_faded_den int := 0;
  v_age_buckets jsonb := '[]'::jsonb;
begin
  select count(*)::int
  into v_recall_calls
  from public.usage_events e
  where (p_owner is null or e.user_id = p_owner)
    and e.event_type = 'mcp_tool_call'
    and e.agent_name is distinct from 'zm-web'
    and e.metadata ->> 'tool' in ('recall', 'build_context')
    and e.occurred_at >= p_since;

  select
    count(*) filter (
      where jsonb_array_length(e.metadata -> 'returned_ids') = 0
    )::int,
    count(*)::int
  into v_empty_recall_num, v_empty_recall_den
  from public.usage_events e
  where (p_owner is null or e.user_id = p_owner)
    and e.event_type = 'mcp_tool_call'
    and e.agent_name is distinct from 'zm-web'
    and e.metadata ? 'returned_ids'
    and e.occurred_at >= p_since;

  select
    count(*) filter (where e.metadata ->> 'empty' = 'false')::int,
    count(*)::int,
    coalesce(sum(e.quantity), 0)
  into v_briefing_hits, v_briefing_total, v_saved_tokens
  from public.usage_events e
  where (p_owner is null or e.user_id = p_owner)
    and e.event_type = 'session_briefing'
    and e.occurred_at >= p_since;

  select count(*)::int
  into v_recall_used_events
  from public.usage_events e
  where (p_owner is null or e.user_id = p_owner)
    and e.event_type = 'recall_used'
    and e.occurred_at >= p_since;

  select
    count(distinct e.metadata ->> 'mem_id') filter (
      where (e.metadata ->> 'relevant')::boolean is true
    )::int,
    count(distinct e.metadata ->> 'mem_id')::int
  into v_precision_num, v_precision_den
  from public.usage_events e
  where (p_owner is null or e.user_id = p_owner)
    and e.event_type = 'recall_used'
    and e.metadata ? 'relevant'
    and e.occurred_at >= p_since;

  select
    count(*)::int,
    coalesce(sum(ceil(length(m.content) / 4.0)), 0)
  into v_captured, v_write_tokens
  from public.memories m
  where (p_owner is null or m.owner_id = p_owner)
    and m.author_kind = 'agent'
    and m.created_at >= p_since;

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
  where (p_owner is null or m.owner_id = p_owner);

  select
    count(*)::int,
    count(*) filter (
      where n.created_at >= now() - interval '24 hours'
    )::int
  into v_entities_total, v_entities_24h
  from public.entities n
  where (p_owner is null or n.created_by = p_owner);

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
    where (p_owner is null or m.owner_id = p_owner)
      and m.invalidated_at is null
  ) age;

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
    where (p_owner is null or m.owner_id = p_owner)
      and m.invalidated_at is null
    group by 1
  ) as c on c.key = d.key;

  -- Reinforced proxy + staleness, over the distinct facts surfaced in the
  -- window. `m.owner_id = e.user_id` makes the recaller-owns-the-fact tie
  -- explicit: in the per-owner case it is a tautology (both equal the owner);
  -- in the instance case it keeps each surfaced fact attributed to the user
  -- who recalled it, exactly as scope isolation already guarantees.
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
        on m.id = hit.mem_id and m.owner_id = e.user_id
    where (p_owner is null or e.user_id = p_owner)
      and e.event_type = 'mcp_tool_call'
      and e.agent_name is distinct from 'zm-web'
      and e.metadata ? 'returned_ids'
      and e.occurred_at >= p_since
    group by hit.mem_id, m.created_at
  ) r;

  with surfaced as (
    select distinct hit.mem_id
    from public.usage_events e
      cross join lateral jsonb_array_elements_text(
        e.metadata -> 'returned_ids'
      ) as hit(mem_id)
      join public.memories m
        on m.id = hit.mem_id and m.owner_id = e.user_id
    where (p_owner is null or e.user_id = p_owner)
      and e.event_type = 'mcp_tool_call'
      and e.agent_name is distinct from 'zm-web'
      and e.metadata ? 'returned_ids'
      and e.occurred_at >= p_since
  ),
  used as (
    select distinct e.metadata ->> 'mem_id' as mem_id
    from public.usage_events e
    where (p_owner is null or e.user_id = p_owner)
      and e.event_type = 'recall_used'
      and (e.metadata ->> 'useful')::boolean is true
      and (
        e.metadata ->> 'source' = 'in_band'
        or coalesce((e.metadata ->> 'confidence')::numeric, 0) >= 0.6
      )
      and e.occurred_at >= p_since
  )
  select
    count(*) filter (where used.mem_id is not null)::int,
    count(*)::int
  into v_usefulness_num, v_usefulness_den
  from surfaced
  left join used on used.mem_id = surfaced.mem_id;

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
    'corpus_median_age_days', v_corpus_median_age_days,
    'faded_num', v_faded_num,
    'faded_den', v_faded_den,
    'age_buckets', v_age_buckets,
    'since', p_since
  );
end;
$$;

comment on function private.dashboard_metrics_core(text, timestamptz) is
  'THE content-free per-owner value-metric definition. p_owner NULL = the '
  'whole instance. Called by dashboard_metrics (one owner) and instance_metrics '
  '(all owners) so a metric cannot mean two different things.';

-- 2. the vitrine wrapper -------------------------------------------------------

-- Same signature, same output. The body is now: null-guard the JWT owner,
-- call core for that owner, and graft on top_facts — the one content-bearing
-- field, kept out of core so it can never reach the operator surface.
create or replace function public.dashboard_metrics(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_usr text := private.current_user_entity_id();
  v_since timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  v_top_facts jsonb := '[]'::jsonb;
begin
  -- A NULL owner would tell core to aggregate the whole instance; an
  -- unauthenticated caller must get zeros, never that. Guard before core.
  if v_usr is null then
    return private.dashboard_metrics_core('__no_such_owner__', v_since)
      || jsonb_build_object('top_facts', '[]'::jsonb);
  end if;

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

  return private.dashboard_metrics_core(v_usr, v_since)
    || jsonb_build_object('top_facts', v_top_facts);
end;
$$;

comment on function public.dashboard_metrics(integer) is
  'Per-user value metrics for the calling user: core metrics from '
  'private.dashboard_metrics_core plus the content-bearing top_facts.';

-- 3. the operator surface ------------------------------------------------------

create or replace function public.instance_metrics(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  v_users_total int := 0;
  v_users_active int := 0;
  v_hygiene_pending int := 0;
  v_eval jsonb := '{}'::jsonb;
begin
  -- Seats: every profile, and everyone who did anything in the window. The CP
  -- counts subscriptions off users_active, so it is a first-class metric.
  select count(*)::int into v_users_total from public.profiles;

  select count(distinct u)::int
  into v_users_active
  from (
    select e.user_id as u
    from public.usage_events e
    where e.user_id is not null and e.occurred_at >= v_since
    union
    select m.owner_id as u
    from public.memories m
    where m.owner_id is not null and m.created_at >= v_since
  ) active;

  -- Open hygiene queue: pairs still awaiting a human decision.
  select count(*)::int
  into v_hygiene_pending
  from public.memory_review_queue
  where resolved_at is null;

  -- The most recent run of each eval harness — the engine's own quality, as
  -- data. Counters and scores only; the probes' text never lands here.
  select coalesce(jsonb_object_agg(latest.harness, latest.row), '{}'::jsonb)
  into v_eval
  from (
    select distinct on (r.harness)
      r.harness,
      jsonb_build_object(
        'run_at', r.run_at,
        'metrics', r.metrics,
        'corpus_size', r.corpus_size,
        'engine_version', r.engine_version
      ) as row
    from public.eval_runs r
    order by r.harness, r.run_at desc
  ) latest;

  -- core over the whole instance (p_owner NULL), plus the operator-only figures.
  return private.dashboard_metrics_core(null, v_since)
    || jsonb_build_object(
      'users_total', v_users_total,
      'users_active', v_users_active,
      'hygiene_pending', v_hygiene_pending,
      'eval_runs', v_eval
    );
end;
$$;

comment on function public.instance_metrics(integer) is
  'Instance-wide aggregate of the same value-metric definitions as the '
  'personal vitrine (private.dashboard_metrics_core over all owners), plus '
  'seats, the open hygiene queue and the latest eval runs. Content-free; '
  'service_role only.';

-- 4. the operator series -------------------------------------------------------

-- Per-day sums of usage_daily across all users, plus the active-user count per
-- day. This is the first real consumer of the S1 rollup: it reads the
-- materialised days rather than recomputing the raw ledger.
create or replace function public.instance_metrics_series(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_days integer := greatest(coalesce(p_days, 30), 1);
  v_from date := (date_trunc('day', now()) - make_interval(days => v_days - 1))::date;
  v_result jsonb;
begin
  with days as (
    select generate_series(v_from, date_trunc('day', now())::date, interval '1 day')::date as day
  ),
  rolled as (
    select
      u.day,
      sum(u.recall_calls)::int as recall_calls,
      sum(u.captured)::int as captured,
      sum(u.saved_tokens) as saved_tokens,
      sum(u.write_tokens) as write_tokens,
      sum(u.briefing_hits)::int as briefing_hits,
      sum(u.briefing_total)::int as briefing_total,
      sum(u.judged)::int as judged,
      sum(u.relevant)::int as relevant,
      sum(u.used)::int as used,
      count(*) filter (
        where u.recall_calls > 0 or u.captured > 0 or u.briefing_total > 0
          or u.judged > 0
      )::int as users_active
    from public.usage_daily u
    where u.day >= v_from
    group by u.day
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'date', to_char(d.day, 'YYYY-MM-DD'),
        'recall_calls', coalesce(r.recall_calls, 0),
        'captured', coalesce(r.captured, 0),
        'saved_tokens', coalesce(r.saved_tokens, 0),
        'write_tokens', coalesce(r.write_tokens, 0),
        'briefing_hits', coalesce(r.briefing_hits, 0),
        'briefing_total', coalesce(r.briefing_total, 0),
        'judged', coalesce(r.judged, 0),
        'relevant', coalesce(r.relevant, 0),
        'used', coalesce(r.used, 0),
        'users_active', coalesce(r.users_active, 0)
      )
      order by d.day
    ),
    '[]'::jsonb
  )
  into v_result
  from days d
    left join rolled r on r.day = d.day;

  return v_result;
end;
$$;

comment on function public.instance_metrics_series(integer) is
  'Per-day instance aggregate: usage_daily summed across all users plus the '
  'active-user count per day. Reads the S1 rollup. Content-free; service_role only.';

-- 5. grants --------------------------------------------------------------------

-- The operator surface is deny-all to end users, like every operational table.
-- REVOKE FROM PUBLIC, not just anon/authenticated: a Postgres function is
-- granted EXECUTE to PUBLIC by default, and both end-user roles inherit that
-- grant — revoking from them alone leaves the PUBLIC grant intact and the
-- function callable. These are SECURITY DEFINER and bypass RLS, so the execute
-- grant is the ONLY gate; it must actually be shut. The core definition is
-- likewise closed so it cannot be reached directly as an instance aggregate.
revoke all on function private.dashboard_metrics_core(text, timestamptz) from public;
revoke all on function public.instance_metrics(integer) from public;
revoke all on function public.instance_metrics_series(integer) from public;
grant execute on function public.instance_metrics(integer) to service_role;
grant execute on function public.instance_metrics_series(integer) to service_role;

-- The vitrine wrapper stays callable by end users (per-user under the JWT) —
-- but core underneath it must not be reachable directly, so dashboard_metrics
-- (SECURITY DEFINER, owned by a superuser) reaches core across the revoke.
