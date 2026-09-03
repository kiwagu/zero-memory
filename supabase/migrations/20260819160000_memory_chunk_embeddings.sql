-- Migration: cover a whole memory with as many embedding windows as it needs
--
-- Purpose:
--   The embedding model reads a fixed 512-token window and its tokenizer
--   truncates to that window SILENTLY — no flag, no warning, no error. For
--   this corpus's English technical prose (~4.5 characters per token) the
--   cliff sits near 2300 characters, and everything past it is simply absent
--   from the stored vector.
--
--   Measured against the real stored vectors on a clone: appending 459
--   characters of entirely unrelated text to a 2400-character body left the
--   vector bit-for-bit identical (cosine 1.000000), and a probe cut from a
--   long memory's own tail found its parent as the top hit 10% of the time
--   (53% within the top ten, 14 of 40 outside the top twenty). The same probe
--   against bodies whose tail still fits inside the window scores 88% and
--   100% with no misses. A long memory is therefore not unfindable — only its
--   OPENING is findable, and whatever a writer puts after the cliff is
--   reachable by exact-wording text match and by nothing else.
--
--   That matters most for exactly the records built to hand work over: their
--   opening states the situation and their closing states what to do next, so
--   truncation eats the actionable half first.
--
--   Coverage is therefore made a function of LENGTH rather than a fixed count
--   of vectors. A fixed count has no principled value — any answer to "why two
--   and not three" is arbitrary, and the record needing a third is exactly the
--   one a fixed two would fail. The only fixed quantity here is the window,
--   which belongs to the model.
--
-- Affected objects:
--   - table public.memory_chunks (new; overflow window vectors, owner-gated)
--   - index memory_chunks_embedding_hnsw_idx (new)
--   - function public.search_memories (create or replace; body only)
--
-- Special considerations:
--   - memories.embedding keeps its exact current meaning and is NOT moved
--     here: it is the whole content handed to the model, which truncates it as
--     before. It stays the record's PRIMARY vector — its identity for
--     write-time dedup and the supersede-candidate probe, and the first window
--     of search coverage. So no stored vector needs recomputing and this
--     migration cannot move an existing result on its own. `memory_chunks`
--     holds only what the primary vector could not reach.
--   - The vector leg still returns ONE row per memory. The legs are unioned
--     and collapsed by taking each memory's CLOSEST window, so a long memory
--     competes for one slot with a better distance rather than occupying
--     several — a capped pack can never be filled by halves of one record.
--   - Each leg draws its own candidate pool before the collapse so both HNSW
--     indexes stay usable; the fused pool is then cut back to the same size as
--     before.
--   - The chunk index cannot carry the head index's `invalidated_at is null`
--     predicate, since that column lives on `memories`. Invalidated rows are
--     excluded by the join to the already-filtered candidate set instead; the
--     cost is index entries for rows search will not return.
--   - Chunks are derived data and cascade with their memory. Rewriting a
--     memory's content (canonicalization to English) replaces its chunks.

set search_path = public, extensions;

-- 1. the overflow windows --------------------------------------------------------

create table public.memory_chunks (
  memory_id text not null references public.memories (id) on delete cascade
    check (public.is_entity_id_with_prefix(memory_id, 'mem')),
  -- 0-based position among the OVERFLOW windows: window 0 is the first span
  -- the primary vector could not reach, not the start of the content.
  ord smallint not null check (ord >= 0),
  embedding extensions.vector(1024) not null,
  primary key (memory_id, ord)
);

comment on table public.memory_chunks is
  'Embedding windows covering the part of a memory''s content that its '
  'primary vector (memories.embedding) cannot reach: the model truncates its '
  'input to a fixed window silently, so without these a long memory is '
  'searchable by its opening alone. Derived data — rebuilt from content, '
  'cascades with the memory. Empty for content that fits the window whole.';

comment on column public.memory_chunks.ord is
  'Position among the overflow windows, 0-based. Successive windows overlap '
  'so a sentence lying across a boundary is stated whole in at least one.';

create index memory_chunks_embedding_hnsw_idx
  on public.memory_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- 2. grants + RLS ----------------------------------------------------------------

revoke all on public.memory_chunks from anon, authenticated;
grant select, insert, update, delete on public.memory_chunks to service_role;
grant select, insert, delete on public.memory_chunks to authenticated;

alter table public.memory_chunks enable row level security;

-- A chunk is exactly as readable as the memory it belongs to. Delegating to
-- the memories row itself — rather than restating the owner/shared-scope rule
-- here — means sharing a memory shares its chunks with no second policy to
-- keep in step, and row security on `memories` still applies inside this
-- expression.
create policy "readers of a memory read its chunks"
on public.memory_chunks
for select
to authenticated
using (
  exists (
    select 1
    from public.memories as m
    where m.id = memory_chunks.memory_id
  )
);

-- Writes are OWNER-only, a narrower test than reading: a shared memory is
-- readable by its scope, but only its owner's write path derives its windows.
-- The write path runs as the user (same client that inserts the memory), so
-- these are what let a normal `remember` store its own overflow windows.
create policy "owners write the windows of their memories"
on public.memory_chunks
for insert
to authenticated
with check (private.owns_memory(memory_id));

-- Deletion is not a lifecycle event here: chunks are DERIVED, and rewriting a
-- memory's content replaces them. That is why this table has a delete path
-- while `memories` deliberately has none.
create policy "owners replace the windows of their memories"
on public.memory_chunks
for delete
to authenticated
using (private.owns_memory(memory_id));

-- 3. search_memories: score each memory by its closest window --------------------

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
    -- Each leg draws its own nearest neighbours so both HNSW indexes stay
    -- usable. A memory reached by several of its windows appears several
    -- times here and is collapsed next, so the leg never returns more than
    -- one row per record.
    vector_pool as (
      (
        select
          candidates.id,
          candidates.embedding operator(extensions.<=>) query_embedding
            as distance
        from candidates
        where candidates.embedding is not null
        order by candidates.embedding operator(extensions.<=>) query_embedding
        limit greatest(k, 1) * (select fusion.pool_multiplier from fusion)
      )
      union all
      (
        select
          chunks.memory_id as id,
          chunks.embedding operator(extensions.<=>) query_embedding as distance
        from public.memory_chunks as chunks
        -- The join is what applies scope, kind and lifecycle filtering to the
        -- chunk leg: candidates is already the RLS-filtered live set.
        join candidates on candidates.id = chunks.memory_id
        order by chunks.embedding operator(extensions.<=>) query_embedding
        limit greatest(k, 1) * (select fusion.pool_multiplier from fusion)
      )
    ),
    -- One row per memory, scored by whichever window is closest: a fact
    -- stated anywhere in the record now speaks for the whole record.
    vector_best as (
      select vector_pool.id, min(vector_pool.distance) as distance
      from vector_pool
      group by vector_pool.id
    ),
    vector_hits as (
      select
        vector_best.id,
        row_number() over (order by vector_best.distance) as rank,
        1 - vector_best.distance as similarity
      from vector_best
      order by vector_best.distance
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
