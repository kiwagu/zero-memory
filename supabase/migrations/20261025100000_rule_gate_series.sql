-- Migration: the rule gate in the daily series, plus a per-rule breakdown
--
-- Purpose:
--   Standing rules can now be delivered at a level a decision model picks per
--   call (whole, as a gate, or as a headline). Whether that pays off has to be
--   measurable per day and per user, on the same substrate as every other
--   value metric, and per rule for the dashboard. This migration adds the
--   gate's measures to the single per-day definition, stores them in the
--   rollup, serves them in the series, and adds a per-rule read for the
--   caller.
--
--   The measures, all per user per day:
--     rule_gate_calls         read calls whose rules went through the gate
--     rules_chars_baseline    characters the rules would have taken whole
--     rules_chars_delivered   characters actually delivered
--     rules_full              rules delivered whole
--     rules_judged            rules the gate named (summed over calls)
--     rule_fetches            reads of one rule's full text that found it
--     guard_refusals          guard-hook refusals reported by ingest
--     judge_latency_ms_sum    the judge's latency, summed over gated calls
--     judge_unavailable       gated calls whose judge did not answer
--     judge_input_tokens      input tokens the judge consumed
--
-- Affected objects:
--   - function private.usage_daily_rows (replaced, ten more columns)
--   - table public.usage_daily (+10 columns)
--   - function public.usage_daily_rollup (replaced)
--   - function public.dashboard_metrics_series (replaced, ten more keys)
--   - function public.instance_metrics_series (replaced, ten more keys)
--   - function public.rule_gate_stats (new)
--
-- Special considerations:
--   - The new columns default to 0, so every stored day stays valid and reads
--     as "nothing measured"; the trailing recompute fills recent days on its
--     next run.
--   - The three per-user bodies are copied verbatim from
--     20260719191500_usage_daily_rollup.sql and the operator series from
--     20260719202121_instance_metrics_operator_surface.sql; every addition is
--     marked `-- rule gate`. Existing columns and keys are unchanged, and so
--     is the operator series' notion of an active user.
--   - private.usage_daily_rows is dropped and re-created because its return
--     table changes. A re-created function gets PUBLIC execute back, so the
--     revoke from PUBLIC is restated; it stays callable by its owner only.
--   - Latency percentiles are not rolled up: they do not add across days. The
--     series carries the latency sum and the call count; percentiles come
--     from the raw events.
--   - A read of a rule id that does not exist is noise, not a fetch: only
--     reads that found the rule count.
--   - public.rule_gate_stats is the caller's own data only (keyed on the
--     signed-in user inside the function), so it is open to authenticated
--     and closed to anon.

set search_path = public;

-- 1. the rollup table gains the columns ----------------------------------------

alter table public.usage_daily
  add column rule_gate_calls integer not null default 0,
  add column rules_chars_baseline integer not null default 0,
  add column rules_chars_delivered integer not null default 0,
  add column rules_full integer not null default 0,
  add column rules_judged integer not null default 0,
  add column rule_fetches integer not null default 0,
  add column guard_refusals integer not null default 0,
  add column judge_latency_ms_sum integer not null default 0,
  add column judge_unavailable integer not null default 0,
  add column judge_input_tokens integer not null default 0;

-- 2. the single metric definition ----------------------------------------------

drop function private.usage_daily_rows(text, timestamptz, timestamptz);

create function private.usage_daily_rows(
  p_usr text,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  day date,
  recall_calls integer,
  captured integer,
  saved_tokens numeric,
  write_tokens numeric,
  briefing_hits integer,
  briefing_total integer,
  judged integer,
  relevant integer,
  used integer,
  -- rule gate
  rule_gate_calls integer,
  rules_chars_baseline integer,
  rules_chars_delivered integer,
  rules_full integer,
  rules_judged integer,
  rule_fetches integer,
  guard_refusals integer,
  judge_latency_ms_sum integer,
  judge_unavailable integer,
  judge_input_tokens integer
)
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  with recalls as (
    select date_trunc('day', e.occurred_at)::date as day, count(*)::int as n
    from public.usage_events e
    where e.user_id = p_usr
      and e.event_type = 'mcp_tool_call'
      and e.agent_name is distinct from 'zm-web'
      and e.metadata ->> 'tool' in ('recall', 'build_context')
      and e.occurred_at >= p_from
      and e.occurred_at < p_to
    group by 1
  ),
  briefings as (
    select
      date_trunc('day', e.occurred_at)::date as day,
      count(*) filter (where e.metadata ->> 'empty' = 'false')::int as hits,
      count(*)::int as total,
      coalesce(sum(e.quantity), 0) as saved_tokens
    from public.usage_events e
    where e.user_id = p_usr
      and e.event_type = 'session_briefing'
      and e.occurred_at >= p_from
      and e.occurred_at < p_to
    group by 1
  ),
  captures as (
    select
      date_trunc('day', m.created_at)::date as day,
      count(*)::int as n,
      coalesce(sum(ceil(length(m.content) / 4.0)), 0) as write_tokens
    from public.memories m
    where m.owner_id = p_usr
      and m.author_kind = 'agent'
      and m.created_at >= p_from
      and m.created_at < p_to
    group by 1
  ),
  -- rule gate: read calls whose standing rules went through the gate, with
  -- what the gate decided and what the judge cost in time.
  gate as (
    select
      date_trunc('day', e.occurred_at)::date as day,
      count(*)::int as calls,
      coalesce(sum((e.metadata -> 'rule_gate' ->> 'chars_baseline')::int), 0)::int as chars_baseline,
      coalesce(sum((e.metadata -> 'rule_gate' ->> 'chars_delivered')::int), 0)::int as chars_delivered,
      coalesce(sum((e.metadata -> 'rule_gate' -> 'levels' ->> 'full')::int), 0)::int as rules_full,
      coalesce(sum(jsonb_array_length(e.metadata -> 'rule_gate' -> 'rules')), 0)::int as rules_judged,
      coalesce(sum((e.metadata -> 'rule_gate' ->> 'latency_ms')::int), 0)::int as latency_sum,
      count(*) filter (where (e.metadata -> 'rule_gate' ->> 'judge_unavailable')::boolean)::int as unavailable
    from public.usage_events e
    where e.user_id = p_usr
      and e.event_type = 'mcp_tool_call'
      and e.metadata ? 'rule_gate'
      and e.occurred_at >= p_from and e.occurred_at < p_to
    group by 1
  ),
  -- rule gate: reads of one rule's full text. Only a read that found the rule
  -- counts; an unknown id is noise, not a fetch after a headline.
  fetches as (
    select date_trunc('day', e.occurred_at)::date as day, count(*)::int as n
    from public.usage_events e
    where e.user_id = p_usr and e.event_type = 'mcp_tool_call'
      and e.metadata ->> 'tool' = 'resource:rule'
      and (e.metadata ->> 'found')::boolean is true
      and e.occurred_at >= p_from and e.occurred_at < p_to
    group by 1
  ),
  -- rule gate: guard-hook refusals the ingest found in a transcript chunk.
  refusals as (
    select date_trunc('day', e.occurred_at)::date as day,
           coalesce(sum(jsonb_array_length(e.metadata -> 'guard_refusals')), 0)::int as n
    from public.usage_events e
    where e.user_id = p_usr and e.event_type = 'ingest_chunk'
      and e.metadata ? 'guard_refusals'
      and e.occurred_at >= p_from and e.occurred_at < p_to
    group by 1
  ),
  -- rule gate: the judge's input tokens.
  judge_tokens as (
    select date_trunc('day', e.occurred_at)::date as day, coalesce(sum(e.quantity), 0)::int as n
    from public.usage_events e
    where e.user_id = p_usr and e.event_type = 'llm_extraction'
      and e.metadata ->> 'purpose' = 'rule_gate'
      and e.occurred_at >= p_from and e.occurred_at < p_to
    group by 1
  ),
  -- Per-day judge quality over recall_used events. Distinct memories per day
  -- so a repeated verdict on the same fact does not inflate a day's counts.
  quality as (
    select
      date_trunc('day', e.occurred_at)::date as day,
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
    where e.user_id = p_usr
      and e.event_type = 'recall_used'
      and e.occurred_at >= p_from
      and e.occurred_at < p_to
    group by 1
  ),
  -- Union of the days any source saw: a day is present if ANY measure has
  -- something to say about it.
  days as (
    select day from recalls
    union select day from briefings
    union select day from captures
    union select day from quality
    -- rule gate
    union select day from gate
    union select day from fetches
    union select day from refusals
    union select day from judge_tokens
  )
  select
    d.day,
    coalesce(r.n, 0)::int,
    coalesce(c.n, 0)::int,
    coalesce(b.saved_tokens, 0),
    coalesce(c.write_tokens, 0),
    coalesce(b.hits, 0)::int,
    coalesce(b.total, 0)::int,
    coalesce(q.judged, 0)::int,
    coalesce(q.relevant, 0)::int,
    coalesce(q.used, 0)::int,
    -- rule gate
    coalesce(g.calls, 0) as rule_gate_calls,
    coalesce(g.chars_baseline, 0) as rules_chars_baseline,
    coalesce(g.chars_delivered, 0) as rules_chars_delivered,
    coalesce(g.rules_full, 0) as rules_full,
    coalesce(g.rules_judged, 0) as rules_judged,
    coalesce(f.n, 0) as rule_fetches,
    coalesce(rf.n, 0) as guard_refusals,
    coalesce(g.latency_sum, 0) as judge_latency_ms_sum,
    coalesce(g.unavailable, 0) as judge_unavailable,
    coalesce(jt.n, 0) as judge_input_tokens
  from days d
    left join recalls r on r.day = d.day
    left join briefings b on b.day = d.day
    left join captures c on c.day = d.day
    left join quality q on q.day = d.day
    -- rule gate
    left join gate g on g.day = d.day
    left join fetches f on f.day = d.day
    left join refusals rf on rf.day = d.day
    left join judge_tokens jt on jt.day = d.day;
$$;

comment on function private.usage_daily_rows(text, timestamptz, timestamptz) is
  'THE per-day definition of the value metrics for one user. Both '
  'dashboard_metrics_series (live tail) and usage_daily_rollup (stored days) '
  'read it, so a metric cannot mean two different things.';

-- Re-created, so PUBLIC holds execute again; only the definer callers need it.
revoke all on function private.usage_daily_rows(text, timestamptz, timestamptz)
  from public;

-- 3. the writer ----------------------------------------------------------------

create or replace function public.usage_daily_rollup(
  p_days integer default 7
)
returns integer
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_days integer := greatest(coalesce(p_days, 7), 1);
  v_from timestamptz := date_trunc('day', timezone('utc', now()))
    - make_interval(days => v_days - 1);
  -- The current day is deliberately included and simply rewritten on the next
  -- run: a partial today is more useful than a missing one, and the trailing
  -- recompute settles it.
  v_to timestamptz := date_trunc('day', timezone('utc', now()))
    + interval '1 day';
  v_written integer := 0;
begin
  with touched as (
    -- Only users who actually did something in the window. A dormant account
    -- costs nothing to skip and would otherwise be recomputed forever.
    select distinct e.user_id
    from public.usage_events e
    where e.user_id is not null
      and e.occurred_at >= v_from
      and e.occurred_at < v_to
    union
    select distinct m.owner_id
    from public.memories m
    where m.owner_id is not null
      and m.created_at >= v_from
      and m.created_at < v_to
  ),
  -- Every day of the window for every touched user, including the quiet ones.
  -- Storing explicit zeros is what makes absence meaningful: the reader below
  -- treats any day at or under the watermark as settled, so a missing row
  -- would be read as zero rather than as "not covered" — and a day whose
  -- events landed late would silently report nothing instead of its real
  -- count. Bounded by active users x window, which is small by construction.
  -- The definition runs ONCE per touched user, not once per user-day.
  measured as (
    select t.user_id, r.*
    from touched t
      cross join lateral private.usage_daily_rows(t.user_id, v_from, v_to) r
  ),
  computed as (
    select
      t.user_id,
      d.day::date as day,
      coalesce(m.recall_calls, 0) as recall_calls,
      coalesce(m.captured, 0) as captured,
      coalesce(m.saved_tokens, 0) as saved_tokens,
      coalesce(m.write_tokens, 0) as write_tokens,
      coalesce(m.briefing_hits, 0) as briefing_hits,
      coalesce(m.briefing_total, 0) as briefing_total,
      coalesce(m.judged, 0) as judged,
      coalesce(m.relevant, 0) as relevant,
      coalesce(m.used, 0) as used,
      -- rule gate
      coalesce(m.rule_gate_calls, 0) as rule_gate_calls,
      coalesce(m.rules_chars_baseline, 0) as rules_chars_baseline,
      coalesce(m.rules_chars_delivered, 0) as rules_chars_delivered,
      coalesce(m.rules_full, 0) as rules_full,
      coalesce(m.rules_judged, 0) as rules_judged,
      coalesce(m.rule_fetches, 0) as rule_fetches,
      coalesce(m.guard_refusals, 0) as guard_refusals,
      coalesce(m.judge_latency_ms_sum, 0) as judge_latency_ms_sum,
      coalesce(m.judge_unavailable, 0) as judge_unavailable,
      coalesce(m.judge_input_tokens, 0) as judge_input_tokens
    from touched t
      cross join generate_series(v_from, v_to - interval '1 day', interval '1 day')
        as d(day)
      left join measured m
        on m.user_id = t.user_id and m.day = d.day::date
  ),
  upserted as (
    insert into public.usage_daily (
      day, user_id, recall_calls, captured, saved_tokens, write_tokens,
      briefing_hits, briefing_total, judged, relevant, used,
      -- rule gate
      rule_gate_calls, rules_chars_baseline, rules_chars_delivered,
      rules_full, rules_judged, rule_fetches, guard_refusals,
      judge_latency_ms_sum, judge_unavailable, judge_input_tokens,
      rolled_up_at
    )
    select
      c.day, c.user_id, c.recall_calls, c.captured, c.saved_tokens,
      c.write_tokens, c.briefing_hits, c.briefing_total, c.judged,
      c.relevant, c.used,
      -- rule gate
      c.rule_gate_calls, c.rules_chars_baseline, c.rules_chars_delivered,
      c.rules_full, c.rules_judged, c.rule_fetches, c.guard_refusals,
      c.judge_latency_ms_sum, c.judge_unavailable, c.judge_input_tokens,
      timezone('utc', now())
    from computed c
    on conflict (day, user_id) do update set
      recall_calls = excluded.recall_calls,
      captured = excluded.captured,
      saved_tokens = excluded.saved_tokens,
      write_tokens = excluded.write_tokens,
      briefing_hits = excluded.briefing_hits,
      briefing_total = excluded.briefing_total,
      judged = excluded.judged,
      relevant = excluded.relevant,
      used = excluded.used,
      -- rule gate
      rule_gate_calls = excluded.rule_gate_calls,
      rules_chars_baseline = excluded.rules_chars_baseline,
      rules_chars_delivered = excluded.rules_chars_delivered,
      rules_full = excluded.rules_full,
      rules_judged = excluded.rules_judged,
      rule_fetches = excluded.rule_fetches,
      guard_refusals = excluded.guard_refusals,
      judge_latency_ms_sum = excluded.judge_latency_ms_sum,
      judge_unavailable = excluded.judge_unavailable,
      judge_input_tokens = excluded.judge_input_tokens,
      rolled_up_at = excluded.rolled_up_at
    returning 1
  )
  select count(*)::int into v_written from upserted;

  return v_written;
end;
$$;

-- 4. the reader ----------------------------------------------------------------

create or replace function public.dashboard_metrics_series(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_usr text := private.current_user_entity_id();
  v_days integer := greatest(coalesce(p_days, 30), 1);
  v_from timestamptz := date_trunc('day', now())
    - make_interval(days => v_days - 1);
  v_watermark date;
  v_result jsonb;
begin
  if v_usr is null then
    return '[]'::jsonb;
  end if;

  select max(day) into v_watermark
  from public.usage_daily
  where user_id = v_usr;

  return (
    with days as (
      select generate_series(
        v_from,
        date_trunc('day', now()),
        interval '1 day'
      )::date as day
    ),
    rolled as (
      select *
      from public.usage_daily u
      where u.user_id = v_usr
        and u.day >= v_from::date
        and v_watermark is not null
        and u.day <= v_watermark
    ),
    live as (
      select *
      from private.usage_daily_rows(
        v_usr,
        -- Start where the rollup stops. With no rollup at all this is just
        -- v_from, i.e. the whole window computed exactly as before.
        greatest(
          v_from,
          case
            when v_watermark is null then v_from
            else (v_watermark + 1)::timestamptz
          end
        ),
        date_trunc('day', now()) + interval '1 day'
      )
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'date', to_char(d.day, 'YYYY-MM-DD'),
          'recall_calls', coalesce(r.recall_calls, l.recall_calls, 0),
          'captured', coalesce(r.captured, l.captured, 0),
          'saved_tokens', coalesce(r.saved_tokens, l.saved_tokens, 0),
          'write_tokens', coalesce(r.write_tokens, l.write_tokens, 0),
          'briefing_hits', coalesce(r.briefing_hits, l.briefing_hits, 0),
          'briefing_total', coalesce(r.briefing_total, l.briefing_total, 0),
          'judged', coalesce(r.judged, l.judged, 0),
          'relevant', coalesce(r.relevant, l.relevant, 0),
          'used', coalesce(r.used, l.used, 0),
          -- rule gate
          'rule_gate_calls', coalesce(r.rule_gate_calls, l.rule_gate_calls, 0),
          'rules_chars_baseline', coalesce(r.rules_chars_baseline, l.rules_chars_baseline, 0),
          'rules_chars_delivered', coalesce(r.rules_chars_delivered, l.rules_chars_delivered, 0),
          'rules_full', coalesce(r.rules_full, l.rules_full, 0),
          'rules_judged', coalesce(r.rules_judged, l.rules_judged, 0),
          'rule_fetches', coalesce(r.rule_fetches, l.rule_fetches, 0),
          'guard_refusals', coalesce(r.guard_refusals, l.guard_refusals, 0),
          'judge_latency_ms_sum', coalesce(r.judge_latency_ms_sum, l.judge_latency_ms_sum, 0),
          'judge_unavailable', coalesce(r.judge_unavailable, l.judge_unavailable, 0),
          'judge_input_tokens', coalesce(r.judge_input_tokens, l.judge_input_tokens, 0)
        )
        order by d.day
      ),
      '[]'::jsonb
    )
    from days d
      left join rolled r on r.day = d.day
      left join live l on l.day = d.day
  );
end;
$$;

-- 5. the operator series --------------------------------------------------------

-- The same ten measures summed across every user, read from the rollup like
-- the rest of the operator series. Grants and comment are kept by the replace.
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
      -- rule gate
      sum(u.rule_gate_calls)::int as rule_gate_calls,
      sum(u.rules_chars_baseline)::int as rules_chars_baseline,
      sum(u.rules_chars_delivered)::int as rules_chars_delivered,
      sum(u.rules_full)::int as rules_full,
      sum(u.rules_judged)::int as rules_judged,
      sum(u.rule_fetches)::int as rule_fetches,
      sum(u.guard_refusals)::int as guard_refusals,
      sum(u.judge_latency_ms_sum)::int as judge_latency_ms_sum,
      sum(u.judge_unavailable)::int as judge_unavailable,
      sum(u.judge_input_tokens)::int as judge_input_tokens,
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
        -- rule gate
        'rule_gate_calls', coalesce(r.rule_gate_calls, 0),
        'rules_chars_baseline', coalesce(r.rules_chars_baseline, 0),
        'rules_chars_delivered', coalesce(r.rules_chars_delivered, 0),
        'rules_full', coalesce(r.rules_full, 0),
        'rules_judged', coalesce(r.rules_judged, 0),
        'rule_fetches', coalesce(r.rule_fetches, 0),
        'guard_refusals', coalesce(r.guard_refusals, 0),
        'judge_latency_ms_sum', coalesce(r.judge_latency_ms_sum, 0),
        'judge_unavailable', coalesce(r.judge_unavailable, 0),
        'judge_input_tokens', coalesce(r.judge_input_tokens, 0),
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

-- 6. the per-rule breakdown ----------------------------------------------------

-- How each standing rule fared at the gate over the window, for the calling
-- user: how often it was judged, at which level it went out, the mean
-- probability the judge gave it, and how often its full text was read back
-- (found reads only). Plus the guard refusals by guard. Content-free: rule
-- ids, counts and a probability; never a rule's text.
create or replace function public.rule_gate_stats(p_days integer default 30)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select private.current_user_entity_id() as usr),
  calls as (
    select e.occurred_at, r.value as rule
    from public.usage_events e, me, jsonb_array_elements(e.metadata -> 'rule_gate' -> 'rules') r
    where e.user_id = me.usr and e.event_type = 'mcp_tool_call' and e.metadata ? 'rule_gate'
      and e.occurred_at >= now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
  ),
  per_rule as (
    select rule ->> 'id' as rule_id,
           count(*)::int as calls,
           count(*) filter (where rule ->> 'level' = 'full')::int as full,
           count(*) filter (where rule ->> 'level' = 'gate')::int as gate,
           count(*) filter (where rule ->> 'level' = 'headline')::int as headline,
           avg((rule ->> 'p')::numeric) as mean_p
    from calls group by 1
  ),
  fetches as (
    select e.metadata ->> 'rule_id' as rule_id, count(*)::int as n
    from public.usage_events e, me
    where e.user_id = me.usr and e.event_type = 'mcp_tool_call' and e.metadata ->> 'tool' = 'resource:rule'
      and (e.metadata ->> 'found')::boolean is true
      and e.occurred_at >= now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
    group by 1
  ),
  refusals as (
    select g.value as guard, count(*)::int as n
    from public.usage_events e, me, jsonb_array_elements_text(e.metadata -> 'guard_refusals') g
    where e.user_id = me.usr and e.event_type = 'ingest_chunk' and e.metadata ? 'guard_refusals'
      and e.occurred_at >= now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
    group by 1
  )
  select jsonb_build_object(
    'rules', coalesce((select jsonb_agg(jsonb_build_object(
               'rule_id', p.rule_id, 'calls', p.calls, 'full', p.full, 'gate', p.gate, 'headline', p.headline,
               'mean_p', round(p.mean_p, 3), 'fetches', coalesce(f.n, 0)) order by p.calls desc)
             from per_rule p left join fetches f on f.rule_id = p.rule_id), '[]'::jsonb),
    'refusals', coalesce((select jsonb_agg(jsonb_build_object('guard', guard, 'count', n) order by n desc) from refusals), '[]'::jsonb)
  );
$$;

comment on function public.rule_gate_stats(integer) is
  'Per-rule rule-gate breakdown for the calling user over the last p_days: '
  'calls, level counts, mean judge probability and found full-text reads per '
  'rule, plus guard refusals per guard. Content-free.';

revoke all on function public.rule_gate_stats(integer) from anon, public;
grant execute on function public.rule_gate_stats(integer) to authenticated, service_role;
