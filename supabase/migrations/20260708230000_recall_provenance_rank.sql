-- Migration: provenance trust factor in recall ranking
--
-- Purpose:
--   Recall (R1) ranks by relevance x kind-weight x recency-decay. Add an author
--   trust factor so a PROVISIONAL watcher memory ranks below an authoritative
--   (in-band agent / human) one at equal relevance. It is a tie-breaker, not a
--   hard demotion: a far more relevant provisional memory still outranks a barely
--   relevant authoritative one.
--
-- Affected objects:
--   - function: public.search_memories (CREATE OR REPLACE; body only, same
--     return type, so no drop needed)
--
-- Special considerations:
--   - Trust factor: 1.0 for authoritative (agent_name is distinct from
--     'watcher'), 0.9 for provisional watcher writes.
--   - Everything else (RRF blend, kind-weight, recency decay, disputed marker)
--     is unchanged. Security invoker; excludes invalidated memories.

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
          )
          -- provenance trust: provisional watcher writes rank below authoritative
          * case
            when candidates.agent_name is distinct from 'watcher' then 1.0
            else 0.9
          end as score
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
  'Hybrid recall (RRF + kind/recency blend) with a provenance trust factor '
  '(provisional watcher writes rank below authoritative at equal relevance) and '
  'a disputed marker per hit. Security invoker; excludes invalidated memories.';
