-- Migration: switch memory full-text search to the 'english' config
--
-- Purpose:
--   memories.fts was generated with the language-agnostic 'simple' config — a
--   choice that predates content canonicalization. Since content became
--   canonical English, 'simple' actively hurts the text leg of hybrid search:
--   no stemming ("introducing" never matches "introduce") and no stopword
--   removal, while websearch_to_tsquery ANDs every term — so natural-language
--   queries almost never match and ranking degenerates to the vector leg
--   alone. Regenerate the column and query with the 'english' config so the
--   text leg stems and drops stopwords on both sides.
--
--   build_context's entity-name matching stays on 'simple' deliberately:
--   entity names are short identifiers (tool/package names), where stemming
--   distorts more than it helps.
--
-- Affected objects:
--   - column public.memories.fts (drop + re-add generated with 'english';
--     the partial GIN index rides on the column and is recreated)
--   - function public.search_memories (both websearch_to_tsquery sites)
--
-- Special considerations:
--   - Dropping a generated column loses no data (content is the source).
--   - The function is re-stated in full (the established revision pattern);
--     only the two tsquery configs change. Security invoker preserved.

set search_path = public, extensions;

alter table public.memories drop column fts;
alter table public.memories
  add column fts tsvector
    generated always as (to_tsvector('english', content)) stored;

comment on column public.memories.fts is
  'Generated from content with the ''english'' config (content is canonical '
  'English): stemming + stopword removal keep the text leg of hybrid search '
  'alive for natural-language queries.';

-- Recreate the partial hot-set index the column drop removed.
create index memories_fts_gin_idx
  on public.memories
  using gin (fts)
  where (invalidated_at is null);

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
  'marker) with the text leg on the ''english'' FTS config — content is '
  'canonical English, so both sides stem and drop stopwords. Security '
  'invoker; excludes invalidated memories.';
