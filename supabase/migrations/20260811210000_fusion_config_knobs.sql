-- Migration: fusion_config table — the fusion parameters of hybrid search as data
--
-- Purpose:
--   The reciprocal-rank-fusion constant (60), the per-leg candidate pool cap
--   (k * 4) and the leg weights (1:1) have lived as literals inside
--   public.search_memories. A production-clone evaluation showed these are
--   the highest-leverage ranking knobs in the system — the RRF constant alone
--   moves the briefing junk share by −23% relative — and tuning them must not
--   cost a function replacement per candidate value. Move them into a
--   single-row config table the function reads: one documented source,
--   tunable with an UPDATE, no copy-paste on future function revisions
--   (same shape as ranking_config for the per-kind profiles).
--
-- Affected objects:
--   - table public.fusion_config (new; single row, read-only for users)
--   - function public.search_memories (CREATE OR REPLACE; body only — the
--     literals become reads of fusion_config, same signature and return
--     table as the reinforcement revision)
--
-- Special considerations:
--   - The seeded row equals today's literals exactly (rrf_k 60, pool k*4,
--     legs 1:1), so this migration changes no search output by construction;
--     behaviour parity was verified output-for-output on a production clone.
--   - An empty fusion_config degrades to the same literal defaults via
--     coalesce — search never breaks on a missing row.
--   - Lowering rrf_k sharpens rank differences (top ranks dominate); raising
--     pool_multiplier admits more candidates into fusion. Both interact:
--     values are accepted only through the retrieval-eval harness, never set
--     ad hoc.

set search_path = public, extensions;

-- 1. table -------------------------------------------------------------------

create table public.fusion_config (
  -- Single-row guard: the only legal key value is true.
  single_row boolean primary key default true check (single_row),
  -- Reciprocal-rank-fusion constant: each leg contributes
  -- leg_weight / (rrf_k + rank). Smaller values sharpen the head of the
  -- ranking; 60 is the classic flattener.
  rrf_k integer not null default 60
    check (rrf_k >= 1),
  -- Per-leg candidate pool cap, as a multiple of the requested k: each leg
  -- feeds its top (k * pool_multiplier) rows into fusion.
  pool_multiplier integer not null default 4
    check (pool_multiplier >= 1),
  -- Relative weight of the vector (semantic) leg in the fused relevance.
  vector_leg_weight double precision not null default 1.0
    check (vector_leg_weight > 0),
  -- Relative weight of the full-text leg in the fused relevance.
  fts_leg_weight double precision not null default 1.0
    check (fts_leg_weight > 0),
  updated_at timestamptz not null default now()
);

comment on table public.fusion_config is
  'Fusion parameters of hybrid memory search (single row): relevance = '
  'vector_leg_weight / (rrf_k + vector_rank) + fts_leg_weight / '
  '(rrf_k + fts_rank), each leg capped at k * pool_multiplier candidates. '
  'Tunable via UPDATE (service_role); users read only. Values are accepted '
  'through the retrieval-eval harness, never ad hoc.';

insert into public.fusion_config (single_row) values (true);

-- 2. grants + RLS -------------------------------------------------------------

-- Global, non-sensitive tuning data: every authenticated user reads it (the
-- security-invoker search runs under the caller's JWT); only migrations and
-- the service role write.
revoke all on public.fusion_config from anon, authenticated;
grant select on public.fusion_config to authenticated;
grant select, insert, update, delete on public.fusion_config to service_role;

alter table public.fusion_config enable row level security;

create policy "fusion config is readable by authenticated users"
on public.fusion_config
for select
to authenticated
using (true);

-- 3. search_memories: read the knobs instead of the literals ------------------

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
    -- The fusion knobs: always exactly one row; an empty table degrades to
    -- the pre-table literals.
    fusion as (
      select
        coalesce(
          (select fc.rrf_k from public.fusion_config as fc limit 1), 60
        ) as rrf_k,
        coalesce(
          (select fc.pool_multiplier from public.fusion_config as fc limit 1),
          4
        ) as pool_multiplier,
        coalesce(
          (
            select fc.vector_leg_weight
            from public.fusion_config as fc
            limit 1
          ),
          1.0
        ) as vector_leg_weight,
        coalesce(
          (select fc.fts_leg_weight from public.fusion_config as fc limit 1),
          1.0
        ) as fts_leg_weight
    ),
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
      limit greatest(k, 1) * (select fusion.pool_multiplier from fusion)
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
      limit greatest(k, 1) * (select fusion.pool_multiplier from fusion)
    ),
    fused as (
      select
        coalesce(vector_hits.id, fts_hits.id) as id,
        -- ::numeric keeps the arithmetic identical to the former literal
        -- `1.0 / (60 + rank)` (numeric division), so the default knobs
        -- reproduce the old scores bit for bit.
        coalesce(
          fusion.vector_leg_weight::numeric
            / (fusion.rrf_k + vector_hits.rank),
          0
        )
          + coalesce(
            fusion.fts_leg_weight::numeric / (fusion.rrf_k + fts_hits.rank),
            0
          ) as relevance,
        vector_hits.similarity,
        fts_hits.id is not null as fts_matched
      from
        vector_hits
        full outer join fts_hits on vector_hits.id = fts_hits.id
        cross join fusion
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
