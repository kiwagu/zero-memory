-- Migration: ranking_config table — one home for the kind decay profiles
--
-- Purpose:
--   The per-kind ranking profile (weight + half-life decay) has lived as a
--   VALUES CTE inside public.search_memories since 20260708070550, which means
--   every function replacement has to copy the numbers verbatim — four copies
--   so far, and the same class of rebuild already lost the partial predicate
--   on the HNSW index once. Move the profile into a real table the function
--   joins: one documented source, tunable with an UPDATE (no release), no
--   copy-paste on future function revisions.
--
--   Also adds decay profiles for the open-loop kinds (task / open-question):
--   ephemeral working notes should fade fast in direct recall. Every
--   pre-existing kind keeps its exact current numbers, so ranking of
--   non-loop kinds is unchanged by construction.
--
-- Affected objects:
--   - table public.ranking_config (new; read-only for users)
--   - function public.search_memories (CREATE OR REPLACE; body only — the
--     inline VALUES CTE becomes a join on ranking_config, same signature and
--     return table as the graded-text-leg revision)
--
-- Special considerations:
--   - Decay stays a ranking-time multiplier: no WHERE by age anywhere, no
--     auto-invalidation — a direct query still finds an old episode.
--   - Unknown kinds (a future vocabulary widening without a profile row)
--     fall back to the same neutral defaults as before: weight 0.85,
--     half-life 365 days.
--   - kind values are not CHECK-constrained against the memories kind list:
--     that list already lives in memories_kind_check and duplicating it here
--     would be one more copy to drift.

set search_path = public, extensions;

-- 1. table -------------------------------------------------------------------

create table public.ranking_config (
  kind text primary key,
  -- Multiplicative bias: durable kinds above transient ones (0..1].
  weight double precision not null
    check (weight > 0 and weight <= 1),
  -- Exponential decay half-life in days: score halves every half_life_days.
  half_life_days double precision not null
    check (half_life_days > 0),
  updated_at timestamptz not null default now()
);

comment on table public.ranking_config is
  'Per-kind ranking profile for hybrid memory search: score = relevance * '
  'weight * 0.5^(age_days / half_life_days). Ranking-time demotion only — '
  'age never invalidates content. Tunable via UPDATE (service_role); users '
  'read only.';

comment on column public.ranking_config.half_life_days is
  'Days for a memory of this kind to lose half its ranking score. Protected '
  'durable kinds (decision/convention/preference/gotcha) decay slowly or '
  'effectively never; transient kinds (episode/task/open-question) fade fast.';

-- 2. seed --------------------------------------------------------------------

-- Pre-existing kinds keep the exact numbers the function carried inline since
-- 20260708070550 (validated by the search-quality holdout runs); the open-loop
-- kinds are new: transient by design, half-life aligned with the open-loops
-- briefing soft-TTL (14 days).
insert into public.ranking_config (kind, weight, half_life_days) values
  ('decision', 1.00, 3650.0),
  ('convention', 1.00, 3650.0),
  ('preference', 1.00, 1825.0),
  ('reference', 0.95, 1825.0),
  ('gotcha', 1.00, 1095.0),
  ('fact', 0.90, 365.0),
  ('episode', 0.70, 30.0),
  ('task', 0.70, 14.0),
  ('open-question', 0.70, 14.0);

-- 3. grants + RLS -------------------------------------------------------------

-- Global, non-sensitive tuning data: every authenticated user reads it (the
-- security-invoker search runs under the caller's JWT); only migrations and
-- the service role write.
revoke all on public.ranking_config from anon, authenticated;
grant select on public.ranking_config to authenticated;
grant select, insert, update, delete on public.ranking_config to service_role;

alter table public.ranking_config enable row level security;

create policy "ranking config is readable by authenticated users"
on public.ranking_config
for select
to authenticated
using (true);

-- 4. search_memories: join the table instead of the inline CTE ----------------

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
      -- Blend relevance with the per-kind profile from ranking_config (the
      -- single documented home of the decay numbers). Unknown kinds fall back
      -- to the same neutral defaults as always: weight 0.85, half-life 365d.
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
          end as score,
        fused.similarity,
        fused.fts_matched
      from
        fused
        join candidates on candidates.id = fused.id
        left join public.ranking_config as cfg on cfg.kind = candidates.kind
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
  'Hybrid recall (RRF + kind/recency blend, provenance trust, disputed '
  'marker, quality signals) with a graded text leg. The per-kind '
  'weight/half-life profile is read from public.ranking_config (ranking-time '
  'decay only — age never invalidates). Security invoker; excludes '
  'invalidated memories.';
