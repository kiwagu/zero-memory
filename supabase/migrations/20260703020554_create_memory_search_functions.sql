-- Migration: create memory search functions
--
-- Purpose:
--   Read-side RPCs for the memory store:
--   - public.search_memories: hybrid retrieval fusing HNSW cosine ranking and
--     full-text ts_rank via Reciprocal Rank Fusion (RRF, 1 / (60 + rank)).
--   - public.find_similar_memory: near-duplicate probe used by `remember`
--     before inserting a new memory.
--
-- Affected objects:
--   - functions: public.search_memories, public.find_similar_memory
--
-- Special considerations:
--   - Both functions are SECURITY INVOKER on purpose: they only read
--     public.memories, so RLS keeps enforcing per-user visibility inside the
--     function. No definer rights are needed (see create-db-functions rule).
--   - search_path is pinned to '' and every object/operator is fully
--     qualified (ltree/vector operators live in the extensions schema).
--   - Being authenticated-callable RPCs in the public schema is intended:
--     they are the read API of the memory store (accepted, documented residue
--     per the create-migration rule).
--   - Invalidated memories (invalidated_at is not null) are always excluded.

-- 1. hybrid search ------------------------------------------------------------

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
      -- Reciprocal Rank Fusion: score = sum over sources of 1 / (60 + rank).
      select
        coalesce(vector_hits.id, fts_hits.id) as id,
        coalesce(1.0 / (60 + vector_hits.rank), 0)
          + coalesce(1.0 / (60 + fts_hits.rank), 0) as score
      from vector_hits
      full outer join fts_hits on vector_hits.id = fts_hits.id
    )
  select
    candidates.id,
    candidates.content,
    candidates.kind,
    candidates.scope::text as scope,
    candidates.visibility,
    candidates.created_at,
    fused.score
  from
    fused
    join candidates on candidates.id = fused.id
  order by fused.score desc, candidates.created_at desc
  limit greatest(k, 1);
$$;

comment on function public.search_memories(
  extensions.vector, text, extensions.ltree[], int, text[]
) is
  'Hybrid memory retrieval: HNSW cosine ranking fused with full-text ts_rank '
  'via RRF (1/(60+rank)). Security invoker so RLS scopes the results to the '
  'caller. Excludes invalidated memories. scope is returned as text.';

-- 2. duplicate probe ----------------------------------------------------------

create or replace function public.find_similar_memory(
  query_embedding extensions.vector (384),
  scope_filter extensions.ltree,
  threshold float default 0.92
)
returns table (
  id text,
  content text,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    memories.id,
    memories.content,
    1 - (memories.embedding operator(extensions.<=>) query_embedding)
      as similarity
  from public.memories
  where
    memories.invalidated_at is null
    and memories.embedding is not null
    and memories.scope operator(extensions.=) scope_filter
    and 1 - (memories.embedding operator(extensions.<=>) query_embedding)
      >= threshold
  order by memories.embedding operator(extensions.<=>) query_embedding
  limit 1;
$$;

comment on function public.find_similar_memory(
  extensions.vector, extensions.ltree, float
) is
  'Returns the single most similar valid memory in the exact scope when its '
  'cosine similarity reaches the threshold. Used by remember() for dedup. '
  'Security invoker: RLS applies.';

-- 3. privileges ---------------------------------------------------------------

-- The read API is for signed-in users only; anon must not probe the store.
revoke all on function public.search_memories(
  extensions.vector, text, extensions.ltree[], int, text[]
) from public, anon;
revoke all on function public.find_similar_memory(
  extensions.vector, extensions.ltree, float
) from public, anon;
grant execute on function public.search_memories(
  extensions.vector, text, extensions.ltree[], int, text[]
) to authenticated;
grant execute on function public.find_similar_memory(
  extensions.vector, extensions.ltree, float
) to authenticated;
