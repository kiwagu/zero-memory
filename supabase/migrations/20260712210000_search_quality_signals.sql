-- Migration: absolute quality signals in hybrid memory search
--
-- Purpose:
--   search_memories ranks with RRF, which is rank-based by construction: the
--   fused score says "this hit is first", never "this hit is close". On a
--   vague query the nearest neighbor of a diffuse embedding still gets rank 1
--   and displays as a top hit even when nothing in the store is actually
--   close. Return two absolute signals alongside the fused score so callers
--   can tell a strong match from rank-one-of-nothing:
--     similarity  — cosine similarity of the vector leg (1 - distance);
--                   null when the hit matched only by text;
--     fts_matched — whether the text leg matched at all.
--   Display-only: the ranking formula is unchanged, so existing orderings
--   (and agent recall parity) are untouched.
--
-- Affected objects:
--   - function public.search_memories (DROP + CREATE: the return table gains
--     two columns, which CREATE OR REPLACE cannot do)
--
-- Special considerations:
--   - Dropping recreates the function with default execute privileges — the
--     same posture the original create relied on. Security invoker preserved.

set search_path = public, extensions;

drop function if exists public.search_memories(
  extensions.vector, text, extensions.ltree[], int, text[]
);

create function public.search_memories(
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
    fts_hits as (
      select
        candidates.id,
        row_number() over (
          order by
            ts_rank(
              candidates.fts,
              websearch_to_tsquery('english', query_text)
            ) desc
        ) as rank
      from candidates
      where candidates.fts @@ websearch_to_tsquery('english', query_text)
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
        left join ranking_config as cfg on cfg.kind = candidates.kind
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
  'marker, english FTS) that also returns absolute quality signals per hit: '
  'vector-leg cosine similarity (null for text-only hits) and whether the '
  'text leg matched. Ranking formula unchanged. Security invoker; excludes '
  'invalidated memories.';
