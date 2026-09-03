-- Migration: surface a `disputed` flag on recall hits
--
-- Purpose:
--   A memory in an unresolved (pending) review-queue conflict is still fully
--   live and returned by recall — the queue is only a flag, not a lifecycle
--   change. So an agent recalling knowledge can silently get two contradicting
--   facts. This adds a `disputed` marker (plus the conflict id and the other
--   memory's id) to each recall hit, so the caller/agent SEES the conflict and
--   can resolve it (resolve_conflict tool) instead of trusting one side blindly.
--
-- Affected objects:
--   - function: public.search_memories (CREATE OR REPLACE; adds 3 return cols)
--
-- Special considerations:
--   - SECURITY INVOKER preserved: the LATERAL join reads memory_review_queue
--     under the caller's RLS (owner-select policy), so a hit is only marked
--     disputed by the caller's OWN pending conflicts. Nothing hidden — the
--     memory is still returned; the flag just says "contested".
--   - Ranking (R1 recency/kind blend) is unchanged; the dispute join is a pure
--     annotation on the final page.

set search_path = public, extensions;

-- Adding return columns changes the function's row type, which CREATE OR REPLACE
-- cannot do — drop the old signature first.
drop function if exists public.search_memories(
  extensions.vector, text, extensions.ltree[], int, text[]
);

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
  score double precision,
  disputed boolean,
  dispute_id text,
  dispute_with text
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
        memories.fts
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
        ) as rank
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
              websearch_to_tsquery('simple', query_text)
            ) desc
        ) as rank
      from candidates
      where candidates.fts @@ websearch_to_tsquery('simple', query_text)
      limit greatest(k, 1) * 4
    ),
    fused as (
      select
        coalesce(vector_hits.id, fts_hits.id) as id,
        coalesce(1.0 / (60 + vector_hits.rank), 0)
          + coalesce(1.0 / (60 + fts_hits.rank), 0) as relevance
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
    ranked.score,
    dispute.queue_id is not null as disputed,
    dispute.queue_id as dispute_id,
    dispute.other as dispute_with
  from
    ranked
    left join lateral (
      -- The most recent unresolved conflict this memory is part of (RLS limits
      -- these to the caller's own queue rows).
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
  'Hybrid recall (RRF + recency/kind blend) with a `disputed` marker: each hit '
  'carries whether it is in an unresolved review-queue conflict (+ dispute_id '
  'and the other memory''s id) so callers see contested facts. Security '
  'invoker; excludes invalidated memories.';
