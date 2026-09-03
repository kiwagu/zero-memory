-- Migration: usage-reinforcement wiring — precomputed ranking multipliers
--
-- Purpose:
--   Facts that PROVED useful (recall_used useful=true — in-band confirmation
--   or the watcher judge) should surface earlier; facts promoted into an
--   always-on rules file are delivered guaranteed and no longer need a high
--   rank. The usefulness signal lives in usage_events, which is deny-all to
--   end users, while search_memories is SECURITY INVOKER — so the ranking
--   cannot aggregate the events at query time. Instead the hygiene cycle
--   PRECOMPUTES one content-free multiplier per memory into
--   memory_reinforcement, and search_memories just multiplies by
--   coalesce(multiplier, 1.0). An empty table reproduces pre-wiring ranking
--   exactly — that property is the holdout baseline.
--
-- Affected objects:
--   - table public.memory_reinforcement            (new; owner-readable)
--   - function public.find_reinforcement_signals   (service_role rollup)
--   - function public.search_memories              (CREATE OR REPLACE; body
--     only — the ranked CTE gains the reinforcement join, same signature and
--     return table as the ranking_config revision)
--
-- Special considerations:
--   - The multiplier CURVE (boost rate, cap, promoted demotion) deliberately
--     lives in the hygiene package config: the value stored here is the
--     finished artifact, so tuning never edits SQL. The check constraint only
--     guards against nonsense (0 < multiplier <= 2).
--   - Positive boost + promoted demotion only in v1: no demotion of
--     surfaced-but-never-used memories — with thin judge coverage that would
--     narrow top-k toward already-seen facts (the anti-gaming concern).

set search_path = public, extensions;

-- 1. multiplier table ----------------------------------------------------------

create table public.memory_reinforcement (
  memory_id text primary key references public.memories (id) on delete cascade
    check (public.is_entity_id_with_prefix(memory_id, 'mem')),
  -- Ranking-time multiplier: > 1 = usefulness boost, < 1 = promoted-to-rules
  -- demotion. Bounded sanity, not policy — the curve lives in package config.
  multiplier double precision not null
    check (multiplier > 0 and multiplier <= 2),
  -- Evidence snapshot for observability (content-free counters).
  useful_events integer not null default 0 check (useful_events >= 0),
  last_used_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.memory_reinforcement is
  'Precomputed usage-reinforcement ranking multipliers (hygiene cycle writes, '
  'search_memories multiplies). Content-free: ids and numbers only. An empty '
  'table = neutral ranking (the pre-wiring baseline).';

-- 2. grants + RLS ----------------------------------------------------------------

revoke all on public.memory_reinforcement from anon, authenticated;
grant select, insert, update, delete
  on public.memory_reinforcement to service_role;
grant select on public.memory_reinforcement to authenticated;

alter table public.memory_reinforcement enable row level security;

-- Owner may inspect their memories' multipliers (the dashboard detail page
-- can surface them later); only the service-role rollup writes.
create policy "owners read their reinforcement multipliers"
on public.memory_reinforcement
for select
to authenticated
using (private.owns_memory(memory_id));

-- 3. signal rollup ----------------------------------------------------------------

-- Usefulness evidence per live memory over the window, plus the promoted
-- flag: in-band confirmations count whole (deterministic proof of use), the
-- judge counts by its confidence and only at >= 0.6 (the same floor the
-- usefulness metric applies). Rows are returned when EITHER signal exists;
-- the multiplier curve is applied by the caller.
create or replace function public.find_reinforcement_signals(
  p_window_days integer default 90
)
returns table (
  memory_id text,
  owner_id text,
  in_band_events integer,
  judge_confidence double precision,
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
        where e.metadata ->> 'source' = 'in_band'
      )::integer as in_band_events,
      coalesce(
        sum((e.metadata ->> 'confidence')::double precision) filter (
          where
            e.metadata ->> 'source' is distinct from 'in_band'
            and coalesce(
              (e.metadata ->> 'confidence')::double precision, 0
            ) >= 0.6
        ),
        0
      ) as judge_confidence,
      max(e.occurred_at) as last_used_at
    from public.usage_events e
    where
      e.event_type = 'recall_used'
      and (e.metadata ->> 'useful')::boolean is true
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
    u.last_used_at,
    (p.memory_id is not null) as promoted
  from
    public.memories m
    left join used u on u.memory_id = m.id
    left join promoted p on p.memory_id = m.id
  where
    m.invalidated_at is null
    and (u.memory_id is not null or p.memory_id is not null);
$$;

comment on function public.find_reinforcement_signals(integer) is
  'Usefulness evidence per live memory (in-band counts, judge confidence at '
  '>= 0.6, promoted-to-rules flag) over the window — the reinforcement '
  'rollup''s input. Security invoker; granted to service_role only (reads '
  'deny-all usage_events).';

revoke all on function public.find_reinforcement_signals(integer)
  from public, anon, authenticated;
grant execute on function public.find_reinforcement_signals(integer)
  to service_role;

-- 4. search_memories: multiply by the precomputed reinforcement ------------------

create or replace function public.search_memories(
  query_embedding extensions.vector,
  query_text text,
  scope_filter extensions.ltree[] default null,
  k int default 12,
  kinds text[] default null
)
returns table (
  id text,
  content text,
  kind text,
  scope text,
  visibility text,
  created_at timestamptz,
  score double precision,
  disputed boolean,
  dispute_id text,
  dispute_with text,
  similarity double precision,
  fts_matched boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with
    -- relaxed = the websearch query with its top-level ANDs OR-joined
    -- (textual rewrite; quoted <-> phrases survive intact). lexemes = the
    -- distinct stems of the query, for the coverage count.
    fts_query as (
      select
        replace(
          websearch_to_tsquery('english', query_text)::text, ' & ', ' | '
        )::tsquery as relaxed,
        array(
          select distinct m[1]
          from regexp_matches(
            websearch_to_tsquery('english', query_text)::text,
            '''([^'']+)''',
            'g'
          ) as m
        ) as lexemes
    ),
    candidates as (
      select
        memories.id,
        memories.content,
        memories.kind,
        memories.scope,
        memories.visibility,
        memories.created_at,
        memories.embedding,
        memories.fts,
        memories.agent_name
      from public.memories
      where
        memories.invalidated_at is null
        and (
          scope_filter is null
          or array_position(scope_filter, memories.scope) is not null
        )
        and (kinds is null or memories.kind = any (kinds))
    ),
    vector_hits as (
      select
        candidates.id,
        row_number() over (
          order by candidates.embedding operator(extensions.<=>) query_embedding
        ) as rank,
        1 - (candidates.embedding operator(extensions.<=>) query_embedding)
          as similarity
      from candidates
      where candidates.embedding is not null
      order by candidates.embedding operator(extensions.<=>) query_embedding
      limit greatest(k, 1) * 4
    ),
    -- Graded text leg: coverage (distinct query stems present) first, cover
    -- density second. The explicit ORDER BY must mirror the window's: LIMIT
    -- without it keeps an arbitrary plan-ordered subset while row_number()
    -- ranks the full match set, silently dropping top-ranked rows.
    fts_scored as (
      select
        candidates.id,
        (
          select count(*)
          from unnest(fts_query.lexemes) as lex
          where
            candidates.fts
              @@ ('''' || replace(lex, '''', '''''') || '''')::tsquery
        ) as matched,
        ts_rank_cd(candidates.fts, fts_query.relaxed) as density
      from candidates, fts_query
      where candidates.fts @@ fts_query.relaxed
    ),
    fts_hits as (
      select
        fts_scored.id,
        row_number() over (
          order by fts_scored.matched desc, fts_scored.density desc
        ) as rank
      from fts_scored
      order by fts_scored.matched desc, fts_scored.density desc
      limit greatest(k, 1) * 4
    ),
    fused as (
      select
        coalesce(vector_hits.id, fts_hits.id) as id,
        coalesce(1.0 / (60 + vector_hits.rank), 0)
          + coalesce(1.0 / (60 + fts_hits.rank), 0) as relevance,
        vector_hits.similarity,
        fts_hits.id is not null as fts_matched
      from vector_hits
      full outer join fts_hits on vector_hits.id = fts_hits.id
    ),
    ranked as (
      -- Blend relevance with the per-kind profile from ranking_config, the
      -- provenance trust factor, and the precomputed usage-reinforcement
      -- multiplier (absent row = neutral 1.0 — the pre-wiring baseline).
      select
        candidates.id,
        candidates.content,
        candidates.kind,
        candidates.scope,
        candidates.visibility,
        candidates.created_at,
        fused.relevance
          * coalesce(cfg.weight, 0.85)
          * exp(
            -ln(2.0)
            * (extract(epoch from (now() - candidates.created_at)) / 86400.0)
            / coalesce(cfg.half_life_days, 365.0)
          )
          -- provenance trust: provisional watcher writes rank below authoritative
          * case
            when candidates.agent_name is distinct from 'watcher' then 1.0
            else 0.9
          end
          * coalesce(reinforcement.multiplier, 1.0) as score,
        fused.similarity,
        fused.fts_matched
      from
        fused
        join candidates on candidates.id = fused.id
        left join public.ranking_config as cfg on cfg.kind = candidates.kind
        left join public.memory_reinforcement as reinforcement
          on reinforcement.memory_id = candidates.id
    )
  select
    ranked.id,
    ranked.content,
    ranked.kind,
    ranked.scope::text as scope,
    ranked.visibility,
    ranked.created_at,
    ranked.score,
    dispute.queue_id is not null as disputed,
    dispute.queue_id as dispute_id,
    dispute.other as dispute_with,
    ranked.similarity,
    ranked.fts_matched
  from
    ranked
    left join lateral (
      select
        q.id as queue_id,
        case when q.memory_a = ranked.id then q.memory_b else q.memory_a end
          as other
      from public.memory_review_queue q
      where
        q.status = 'pending'
        and (q.memory_a = ranked.id or q.memory_b = ranked.id)
      order by q.created_at desc
      limit 1
    ) as dispute on true
  order by ranked.score desc, ranked.created_at desc
  limit greatest(k, 1);
$$;

comment on function public.search_memories(
  extensions.vector, text, extensions.ltree[], int, text[]
) is
  'Hybrid recall (RRF + kind/recency blend from ranking_config, provenance '
  'trust, disputed marker, quality signals, graded text leg) times the '
  'precomputed usage-reinforcement multiplier from memory_reinforcement '
  '(useful facts rise, promoted-to-rules facts sink; missing row = neutral). '
  'Security invoker; excludes invalidated memories.';
