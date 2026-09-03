-- Migration: epistemic valence + single-subject disputes (challenge / stale-suspect)
--
-- Purpose:
--   Negative half of the recall-feedback loop. Until now recall_used evidence
--   only reinforced upward (useful=true); a memory that MISLED the session —
--   an applied fix that failed, a stale decision the agent followed — left no
--   trace, so a polluted record was indistinguishable from a helpful one.
--   This migration:
--     1. teaches the review queue single-SUBJECT disputes (memory_b null):
--        an agent's explicit challenge of one memory, and the hygiene cycle's
--        stale-suspect flag raised after repeated misled signals;
--     2. extends the reinforcement signal rollup with misled evidence so the
--        precomputed ranking multiplier can demote (never invalidate);
--     3. adds the stale-suspect rollup with a resolved-after re-queue guard:
--        a dismissed suspicion is re-raised only on evidence NEWER than the
--        dismissal.
--
-- Affected objects:
--   - table public.memory_review_queue           (memory_b nullable; verdicts
--     + shape + winner constraints; partial unique pending index)
--   - function public.find_reinforcement_signals (DROP + recreate: adds
--     misled evidence columns; service_role only, same caller)
--   - function public.find_stale_suspects        (new; service_role rollup)
--
-- Special considerations:
--   - No auto-invalidation anywhere: misled evidence only demotes ranking
--     (bounded multiplier, curve lives in package config) and queues a REVIEW
--     row. Retirement stays an owner/agent resolution via the triage tools.
--   - Valence rides usage_events.metadata (valence='misled'): no schema
--     change on the deny-all events table. Existing metrics either filter on
--     useful=true or count raw recall_used rows that already mix
--     useful=false judge verdicts, so the new rows shift no metric semantics.

set search_path = public;

-- 1. review queue: single-subject dispute shape --------------------------------

alter table public.memory_review_queue
  alter column memory_b drop not null;

-- The inline column check predates nullability and returns FALSE for null
-- (is_entity_id_with_prefix is not null-tolerant); restate it per shape.
alter table public.memory_review_queue
  drop constraint memory_review_queue_memory_b_check;
alter table public.memory_review_queue
  add constraint memory_review_queue_memory_b_check
  check (
    memory_b is null or public.is_entity_id_with_prefix(memory_b, 'mem')
  );

-- Pair ordering only applies to actual pairs.
alter table public.memory_review_queue
  drop constraint memory_review_queue_pair_order;
alter table public.memory_review_queue
  add constraint memory_review_queue_pair_order
  check (memory_b is null or memory_a < memory_b);

-- New single-subject verdict classes.
alter table public.memory_review_queue
  drop constraint memory_review_queue_verdict_check;
alter table public.memory_review_queue
  add constraint memory_review_queue_verdict_check
  check (
    verdict in (
      'duplicate', 'supersedes', 'contradiction', 'stale_suspect', 'challenged'
    )
  );

-- Single-subject verdicts have no second memory, pair verdicts always do.
alter table public.memory_review_queue
  add constraint memory_review_queue_subject_shape
  check ((memory_b is null) = (verdict in ('stale_suspect', 'challenged')));

-- The original IN-check passes NULL (not false) for a foreign winner when
-- memory_b is null, so it must be restated per shape.
alter table public.memory_review_queue
  drop constraint memory_review_queue_winner_in_pair;
alter table public.memory_review_queue
  add constraint memory_review_queue_winner_in_pair
  check (
    winner is null
    or (memory_b is not null and winner in (memory_a, memory_b))
    or (memory_b is null and winner = memory_a)
  );

-- One OPEN single-subject dispute per memory and verdict class. The pair
-- uniqueness constraint treats NULL memory_b as distinct, so it cannot cover
-- this; resolved history rows stay unrestricted.
create unique index memory_review_queue_single_pending_uidx
  on public.memory_review_queue (memory_a, verdict)
  where memory_b is null and status = 'pending';

-- Owner RLS restated for the nullable side: owns_memory(null) is false, so
-- the original both-sides predicate would hide single-subject rows from
-- their owner — including the recall disputed marker, whose lateral join
-- reads this table under the caller's RLS (search_memories is invoker).
drop policy "owners read their review rows" on public.memory_review_queue;
create policy "owners read their review rows"
on public.memory_review_queue
for select
to authenticated
using (
  private.owns_memory(memory_a)
  and (memory_b is null or private.owns_memory(memory_b))
);

drop policy "owners resolve their review rows" on public.memory_review_queue;
create policy "owners resolve their review rows"
on public.memory_review_queue
for update
to authenticated
using (
  private.owns_memory(memory_a)
  and (memory_b is null or private.owns_memory(memory_b))
)
with check (
  private.owns_memory(memory_a)
  and (memory_b is null or private.owns_memory(memory_b))
);

-- 2. reinforcement signals: add the misled evidence ----------------------------

-- Return type changes, so the function is dropped and recreated. Useful-side
-- semantics are unchanged; the WHERE-level useful filter moves into the
-- aggregate filters because one pass now collects both valences.
drop function public.find_reinforcement_signals(integer);

create function public.find_reinforcement_signals(
  p_window_days integer default 90
)
returns table (
  memory_id text,
  owner_id text,
  in_band_events integer,
  judge_confidence double precision,
  misled_events integer,
  misled_confidence double precision,
  last_used_at timestamptz,
  promoted boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with used as (
    select
      e.metadata ->> 'mem_id' as memory_id,
      count(*) filter (
        where
          e.metadata ->> 'source' = 'in_band'
          and (e.metadata ->> 'useful')::boolean is true
      )::integer as in_band_events,
      coalesce(
        sum((e.metadata ->> 'confidence')::double precision) filter (
          where
            (e.metadata ->> 'useful')::boolean is true
            and e.metadata ->> 'source' is distinct from 'in_band'
            and coalesce(
              (e.metadata ->> 'confidence')::double precision, 0
            ) >= 0.6
        ),
        0
      ) as judge_confidence,
      -- Misled evidence mirrors the useful pattern: explicit agent challenges
      -- count whole (deterministic self-attribution), the judge counts by its
      -- confidence and only at >= 0.6.
      count(*) filter (
        where
          e.metadata ->> 'valence' = 'misled'
          and e.metadata ->> 'source' = 'challenge'
      )::integer as misled_events,
      coalesce(
        sum((e.metadata ->> 'confidence')::double precision) filter (
          where
            e.metadata ->> 'valence' = 'misled'
            and e.metadata ->> 'source' = 'judge'
            and coalesce(
              (e.metadata ->> 'confidence')::double precision, 0
            ) >= 0.6
        ),
        0
      ) as misled_confidence,
      max(e.occurred_at) filter (
        where (e.metadata ->> 'useful')::boolean is true
      ) as last_used_at
    from public.usage_events e
    where
      e.event_type = 'recall_used'
      and e.occurred_at
        >= now() - make_interval(days => greatest(p_window_days, 1))
    group by 1
  ),
  promoted as (
    select rc.memory_id
    from public.rule_candidates rc
    where rc.status = 'promoted'
  )
  select
    m.id as memory_id,
    m.owner_id,
    coalesce(u.in_band_events, 0) as in_band_events,
    coalesce(u.judge_confidence, 0)::double precision as judge_confidence,
    coalesce(u.misled_events, 0) as misled_events,
    coalesce(u.misled_confidence, 0)::double precision as misled_confidence,
    u.last_used_at,
    (p.memory_id is not null) as promoted
  from
    public.memories m
    left join used u on u.memory_id = m.id
    left join promoted p on p.memory_id = m.id
  where
    m.invalidated_at is null
    and (
      p.memory_id is not null
      or coalesce(u.in_band_events, 0) > 0
      or coalesce(u.judge_confidence, 0) > 0
      or coalesce(u.misled_events, 0) > 0
      or coalesce(u.misled_confidence, 0) > 0
    );
$$;

comment on function public.find_reinforcement_signals(integer) is
  'Usefulness AND misled evidence per live memory (in-band/challenge counts, '
  'judge confidence at >= 0.6 per valence, promoted-to-rules flag) over the '
  'window — the reinforcement rollup''s input. Security invoker; granted to '
  'service_role only (reads deny-all usage_events).';

revoke all on function public.find_reinforcement_signals(integer)
  from public, anon, authenticated;
grant execute on function public.find_reinforcement_signals(integer)
  to service_role;

-- 3. stale-suspect rollup ------------------------------------------------------

-- Live memories whose misled evidence crossed the threshold and that carry no
-- open single-subject dispute. The resolved-after guard means a memory whose
-- suspicion an owner dismissed is only re-raised by evidence NEWER than that
-- resolution — a judged question is not re-asked on the same facts.
create function public.find_stale_suspects(
  p_threshold integer default 2,
  p_window_days integer default 90
)
returns table (
  memory_id text,
  owner_id text,
  misled_count integer,
  last_misled_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with misled as (
    select
      e.metadata ->> 'mem_id' as memory_id,
      count(*)::integer as misled_count,
      max(e.occurred_at) as last_misled_at
    from public.usage_events e
    where
      e.event_type = 'recall_used'
      and e.metadata ->> 'valence' = 'misled'
      and (
        e.metadata ->> 'source' = 'challenge'
        or (
          e.metadata ->> 'source' = 'judge'
          and coalesce(
            (e.metadata ->> 'confidence')::double precision, 0
          ) >= 0.6
        )
      )
      and e.occurred_at
        >= now() - make_interval(days => greatest(p_window_days, 1))
      and e.occurred_at > coalesce(
        (
          select max(q.resolved_at)
          from public.memory_review_queue q
          where
            q.memory_a = e.metadata ->> 'mem_id'
            and q.memory_b is null
            and q.status in ('resolved', 'dismissed')
        ),
        '-infinity'::timestamptz
      )
    group by 1
  )
  select
    m.id as memory_id,
    m.owner_id,
    misled.misled_count,
    misled.last_misled_at
  from misled
  join public.memories m on m.id = misled.memory_id
  where
    m.invalidated_at is null
    and misled.misled_count >= greatest(p_threshold, 1)
    and not exists (
      select 1
      from public.memory_review_queue q
      where
        q.memory_a = m.id
        and q.memory_b is null
        and q.status = 'pending'
    );
$$;

comment on function public.find_stale_suspects(integer, integer) is
  'Live memories with >= threshold qualifying misled signals (challenge or '
  'judge >= 0.6) in the window, no open single-subject dispute, counting only '
  'evidence newer than the last resolved/dismissed single-subject row (re- '
  'queue guard). Security invoker; granted to service_role only.';

revoke all on function public.find_stale_suspects(integer, integer)
  from public, anon, authenticated;
grant execute on function public.find_stale_suspects(integer, integer)
  to service_role;
