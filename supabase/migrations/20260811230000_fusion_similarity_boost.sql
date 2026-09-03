-- Migration: banded similarity boost — give exact matches back their margin
--
-- Purpose:
--   Reciprocal-rank fusion keeps only the ORDER of the vector leg: a perfect
--   match (cosine similarity 1.0) earns exactly the same contribution as an
--   ordinary rank-1 hit, so nothing distinguishes "the very memory you asked
--   for" from "the nearest of several mediocre candidates". Measured on a
--   production clone, this is the one axis no rank-side knob reaches: leg
--   re-weighting cuts briefing junk deeply but always pays with recall of
--   paraphrase-style queries, because it only shifts weight between two
--   rank-flattened legs. This term instead ADDS discrimination inside the
--   vector leg: relevance gains similarity_boost_weight * band(similarity).
--
-- Shape — banded affine, deliberately NOT per-pool min-max:
--   band(s) = clamp((s - floor) / (ceiling - floor), 0, 1). Per-pool min-max
--   would stretch a mediocre pool's meaningless 0.02 similarity spread to the
--   full 0..1 scale (noise amplification); the fixed band only rewards
--   genuinely close matches and gives an exact match its full boost
--   regardless of pool composition. Band edges are knobs with measured
--   defaults for this corpus: below ~0.80 cosine means merely "same general
--   domain" (noise), ~0.92 is already the near-duplicate zone.
--
-- Affected objects:
--   - table public.fusion_config (3 new columns, defaults neutral)
--   - function public.search_memories (CREATE OR REPLACE; body only)
--
-- Special considerations:
--   - similarity_boost_weight defaults to 0: this migration changes no search
--     output by construction. A non-zero value is accepted only through the
--     retrieval-eval harness.
--   - The term rides INSIDE the multiplier chain (kind weight, decay, trust,
--     reinforcement), so aging still demotes a boosted row proportionally —
--     demotion, not exemption.
--   - Rows reached only by the text leg carry no similarity (never computed);
--     they get no boost, which is honest rather than a gap.

set search_path = public, extensions;

-- 1. knobs ---------------------------------------------------------------------

alter table public.fusion_config
  add column similarity_boost_weight double precision not null default 0
    check (similarity_boost_weight >= 0),
  add column similarity_band_floor double precision not null default 0.80
    check (similarity_band_floor >= 0),
  add column similarity_band_ceiling double precision not null default 0.92
    check (similarity_band_ceiling <= 1);

alter table public.fusion_config
  add constraint fusion_config_similarity_band_check
    check (similarity_band_floor < similarity_band_ceiling);

comment on column public.fusion_config.similarity_boost_weight is
  'Additive relevance boost for vector-leg hits: weight * clamp((similarity '
  '- band_floor) / (band_ceiling - band_floor), 0, 1). 0 disables the term. '
  'Same score units as the RRF leg contributions (a rank-1 leg at the '
  'default constant contributes ~1/61).';

comment on column public.fusion_config.similarity_band_floor is
  'Cosine similarity at which the boost starts. Below it the boost is 0: on '
  'this corpus low cosine means merely "same general domain".';

comment on column public.fusion_config.similarity_band_ceiling is
  'Cosine similarity at which the boost saturates at its full weight; the '
  'near-duplicate zone starts around here.';

-- 2. search_memories: add the banded boost to the fused relevance --------------

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
        ) as fts_leg_weight,
        coalesce(
          (
            select fc.similarity_boost_weight
            from public.fusion_config as fc
            limit 1
          ),
          0.0
        ) as similarity_boost_weight,
        coalesce(
          (
            select fc.similarity_band_floor
            from public.fusion_config as fc
            limit 1
          ),
          0.80
        ) as similarity_band_floor,
        coalesce(
          (
            select fc.similarity_band_ceiling
            from public.fusion_config as fc
            limit 1
          ),
          0.92
        ) as similarity_band_ceiling
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
        -- ::numeric keeps the leg arithmetic identical to the former literal
        -- `1.0 / (60 + rank)` (numeric division); the boost term is additive
        -- and exactly 0 at the default weight, so the default knobs still
        -- reproduce the old scores bit for bit.
        coalesce(
          fusion.vector_leg_weight::numeric
            / (fusion.rrf_k + vector_hits.rank),
          0
        )
          + coalesce(
            fusion.fts_leg_weight::numeric / (fusion.rrf_k + fts_hits.rank),
            0
          )
          + fusion.similarity_boost_weight
            * least(
              1.0,
              greatest(
                0.0,
                (
                  coalesce(vector_hits.similarity, 0)
                    - fusion.similarity_band_floor
                )
                  / (
                    fusion.similarity_band_ceiling
                      - fusion.similarity_band_floor
                  )
              )
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
