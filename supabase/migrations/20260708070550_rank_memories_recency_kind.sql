-- Migration: blend recency decay and per-kind weight into memory ranking (R1)
--
-- Purpose:
--   First ranking-signal upgrade of the recall read path. Until now
--   public.search_memories ordered purely by hybrid relevance (RRF over HNSW
--   cosine + FTS ts_rank), tie-broken by created_at. That treats a two-year-old
--   episode and a fresh decision as equally rankable on relevance alone, so
--   stale transient notes can outrank durable knowledge.
--
--   This replaces the function (same signature, same return columns) with a
--   blended score:
--
--       final = rrf_relevance * kind_weight * recency_factor
--
--   - kind_weight biases durable kinds (decision/convention) over transient
--     ones (episode);
--   - recency_factor is an exponential half-life decay on age, with a
--     per-kind half-life so an episode fades in weeks while a decision barely
--     moves over years.
--
--   Deterministic, no LLM, evaluated inside the DB so ordering + limit still
--   happen at the source. This is the substrate later R4 signals (e.g. usage
--   reinforcement) add further multiplicative terms onto.
--
-- Affected objects:
--   - function: public.search_memories  (CREATE OR REPLACE; signature and
--     returned columns unchanged, so contracts/types/callers are untouched)
--
-- Special considerations:
--   - SECURITY INVOKER preserved: the function still only reads public.memories,
--     so RLS keeps scoping results to the caller. search_path pinned to '' with
--     every extension operator fully qualified; the decay/weight math uses only
--     pg_catalog built-ins (exp/ln/now/extract), always resolvable.
--   - The tuning block is a single VALUES CTE (ranking_config). It is the one
--     place to adjust weights and half-lives; unknown kinds fall back to a
--     neutral default. Not runtime-configurable by design (there is no runtime
--     settings table in the current schema) — tuning is a migration edit.
--   - Invalidated memories (invalidated_at is not null) are still excluded.
--   - The `score` column now carries the blended value, not the raw RRF. It was
--     already an opaque ordering scalar to callers (they order by / display it),
--     so the shape and meaning-as-"higher-is-better" are unchanged.

-- Migration DDL parses ltree/vector operators; keep the extensions schema
-- resolvable while the file runs (the function still pins its own search_path).
set search_path = public, extensions;

create or replace function public.search_memories(
  query_embedding extensions.vector (384),
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
  score double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with
    -- Single tuning point for the ranking signals. weight biases durable kinds
    -- above transient ones; half_life_days sets how fast a kind's relevance
    -- decays with age (episode fades in weeks, a decision holds for years).
    ranking_config (kind, weight, half_life_days) as (
      values
        ('decision', 1.00, 3650.0),
        ('convention', 1.00, 3650.0),
        ('preference', 1.00, 1825.0),
        ('reference', 0.95, 1825.0),
        ('gotcha', 1.00, 1095.0),
        ('fact', 0.90, 365.0),
        ('episode', 0.70, 30.0)
    ),
    candidates as (
      -- Rows the caller may see (RLS applies), still valid, matching filters.
      select
        memories.id,
        memories.content,
        memories.kind,
        memories.scope,
        memories.visibility,
        memories.created_at,
        memories.embedding,
        memories.fts
      from public.memories
      where
        memories.invalidated_at is null
        and (
          scope_filter is null
          -- array_position resolves ltree equality via the type cache, so it
          -- stays valid under the pinned empty search_path (a plain
          -- `scope = any (...)` would fail to find the ltree `=` operator).
          or array_position(scope_filter, memories.scope) is not null
        )
        and (kinds is null or memories.kind = any (kinds))
    ),
    vector_hits as (
      -- Cosine ranking over the HNSW index; oversample to give RRF room.
      select
        candidates.id,
        row_number() over (
          order by candidates.embedding operator(extensions.<=>) query_embedding
        ) as rank
      from candidates
      where candidates.embedding is not null
      order by candidates.embedding operator(extensions.<=>) query_embedding
      limit greatest(k, 1) * 4
    ),
    fts_hits as (
      -- Full-text ranking with the language-agnostic 'simple' config.
      select
        candidates.id,
        row_number() over (
          order by
            ts_rank(
              candidates.fts,
              websearch_to_tsquery('simple', query_text)
            ) desc
        ) as rank
      from candidates
      where candidates.fts @@ websearch_to_tsquery('simple', query_text)
      limit greatest(k, 1) * 4
    ),
    fused as (
      -- Reciprocal Rank Fusion: relevance = sum over sources of 1 / (60 + rank).
      select
        coalesce(vector_hits.id, fts_hits.id) as id,
        coalesce(1.0 / (60 + vector_hits.rank), 0)
          + coalesce(1.0 / (60 + fts_hits.rank), 0) as relevance
      from vector_hits
      full outer join fts_hits on vector_hits.id = fts_hits.id
    ),
    ranked as (
      -- Blend relevance with per-kind weight and half-life recency decay.
      -- recency_factor = 0.5 ^ (age_days / half_life_days) in (0, 1].
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
          ) as score
      from
        fused
        join candidates on candidates.id = fused.id
        left join ranking_config as cfg on cfg.kind = candidates.kind
    )
  select
    ranked.id,
    ranked.content,
    ranked.kind,
    ranked.scope::text as scope,
    ranked.visibility,
    ranked.created_at,
    ranked.score
  from ranked
  order by ranked.score desc, ranked.created_at desc
  limit greatest(k, 1);
$$;

comment on function public.search_memories(
  extensions.vector, text, extensions.ltree[], int, text[]
) is
  'Hybrid memory retrieval (RRF over HNSW cosine + FTS ts_rank) blended with a '
  'per-kind weight and half-life recency decay: final = relevance * weight * '
  '0.5^(age_days/half_life). Security invoker so RLS scopes results. Excludes '
  'invalidated memories. scope returned as text.';
