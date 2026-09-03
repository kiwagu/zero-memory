-- Migration: daily usage rollup (public.usage_daily) behind one metric definition
--
-- Purpose:
--   Give the value metrics a stable daily substrate. Today every dashboard
--   series recomputes itself from the raw ledger on each call, which ties two
--   things together that should not be: how far back a chart can look, and
--   how long raw events must be kept. A materialised day lets horizons grow
--   past 90 days and lets raw events be retired later without erasing the
--   history they describe.
--
--   The risk in any rollup is drift — a stored number that quietly stops
--   meaning what the live chart means. This migration is built to make that
--   impossible rather than unlikely: the per-day measures are lifted OUT of
--   dashboard_metrics_series into a single function, and both the writer and
--   the reader call it. There is one definition of each metric, in one place,
--   and no way to change the chart without changing the rollup.
--
-- Affected objects:
--   - function private.usage_daily_rows (new — THE definition)
--   - table public.usage_daily (new, deny-all)
--   - function public.usage_daily_rollup (new, writer)
--   - function public.dashboard_metrics_series (replaced: same output,
--     now reads rolled-up days and computes only the unrolled tail)
--
-- Special considerations:
--   - Behaviour is unchanged when the rollup has never run: with no rolled
--     day the reader computes every requested day live, exactly as before.
--     An empty rollup can therefore never show a user zeros for days that
--     have data — the failure mode a naive "read the table" reader would
--     have had.
--   - The writer recomputes a trailing window rather than only new days:
--     recall_used verdicts arrive out of band from the watcher's usefulness
--     judge, well after the day they belong to. A write-once rollup would
--     freeze those days before their evidence landed.
--   - Day bucketing is pinned to UTC. A stored day must not depend on the
--     timezone of whichever session happened to write it; both stacks
--     already run UTC, so nothing shifts today.
--   - Rows are per (day, user). Background work metered with no user id is
--     deliberately absent: it belongs to no one's series. Instance-wide
--     sums keep reading the raw ledger, as policy_spend does.

set search_path = public;

-- 1. the single metric definition ----------------------------------------------

-- Lifted verbatim out of dashboard_metrics_series. Every measure the daily
-- chart shows is defined here and nowhere else; the chart and the rollup are
-- two callers of this one function.
--
-- Returns only days that carry signal — a user's quiet Sunday produces no
-- row. Callers that need a dense axis fill the gaps themselves (the series
-- does, with zeros), which keeps the stored rollup from growing a row per
-- user per day forever.
create or replace function private.usage_daily_rows(
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
  used integer
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
    coalesce(q.used, 0)::int
  from days d
    left join recalls r on r.day = d.day
    left join briefings b on b.day = d.day
    left join captures c on c.day = d.day
    left join quality q on q.day = d.day;
$$;

comment on function private.usage_daily_rows(text, timestamptz, timestamptz) is
  'THE per-day definition of the value metrics for one user. Both '
  'dashboard_metrics_series (live tail) and usage_daily_rollup (stored days) '
  'read it, so a metric cannot mean two different things.';

-- 2. the rollup table ----------------------------------------------------------

create table public.usage_daily (
  day date not null,
  user_id text not null references public.profiles (id)
    check (public.is_entity_id_with_prefix(user_id, 'usr')),
  recall_calls integer not null default 0,
  captured integer not null default 0,
  saved_tokens numeric not null default 0,
  write_tokens numeric not null default 0,
  briefing_hits integer not null default 0,
  briefing_total integer not null default 0,
  judged integer not null default 0,
  relevant integer not null default 0,
  used integer not null default 0,
  -- When this day was last recomputed. A day recomputed long after it ended
  -- carries late-arriving judge verdicts; the stamp is how an operator tells
  -- a settled day from one still moving.
  rolled_up_at timestamptz not null default timezone('utc', now()),
  primary key (day, user_id)
);

comment on table public.usage_daily is
  'Daily rollup of the per-user value metrics, written by usage_daily_rollup '
  'from private.usage_daily_rows. Substrate for long horizons and future '
  'operator aggregates. Deny-all RLS: service_role only; users see these '
  'numbers through the dashboard RPCs.';

-- Reading a user's stretch of days is the only access pattern; the primary
-- key leads with day, so the per-user lookup gets its own index.
create index usage_daily_user_id_day_idx
  on public.usage_daily
  using btree (user_id, day);

revoke all on public.usage_daily from anon, authenticated;
grant select, insert, update on public.usage_daily to service_role;

alter table public.usage_daily enable row level security;

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
      coalesce(m.used, 0) as used
    from touched t
      cross join generate_series(v_from, v_to - interval '1 day', interval '1 day')
        as d(day)
      left join measured m
        on m.user_id = t.user_id and m.day = d.day::date
  ),
  upserted as (
    insert into public.usage_daily (
      day, user_id, recall_calls, captured, saved_tokens, write_tokens,
      briefing_hits, briefing_total, judged, relevant, used, rolled_up_at
    )
    select
      c.day, c.user_id, c.recall_calls, c.captured, c.saved_tokens,
      c.write_tokens, c.briefing_hits, c.briefing_total, c.judged,
      c.relevant, c.used, timezone('utc', now())
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
      rolled_up_at = excluded.rolled_up_at
    returning 1
  )
  select count(*)::int into v_written from upserted;

  return v_written;
end;
$$;

comment on function public.usage_daily_rollup(integer) is
  'Recomputes and upserts the trailing p_days days of public.usage_daily for '
  'every user active in that window. Idempotent; returns rows written. The '
  'trailing recompute is what lets out-of-band judge verdicts land in the '
  'day they belong to.';

revoke all on function public.usage_daily_rollup(integer)
  from anon, authenticated;
grant execute on function public.usage_daily_rollup(integer) to service_role;

-- 4. the reader ----------------------------------------------------------------

-- Same signature, same JSON, same numbers — the body now takes settled days
-- from the rollup and computes only the tail the rollup has not reached.
--
-- The watermark is the crux. Days are served from the rollup only up to the
-- newest day it actually holds for this user; everything after that is
-- computed live. So a rollup that has never run, or one that stopped a week
-- ago, degrades to live computation rather than reporting zeros for days it
-- simply never wrote.
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
          'used', coalesce(r.used, l.used, 0)
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

comment on function public.dashboard_metrics_series(integer) is
  'Per-day value metrics for the calling user. Settled days come from '
  'public.usage_daily, the unrolled tail is computed live from '
  'private.usage_daily_rows — one definition behind both.';
