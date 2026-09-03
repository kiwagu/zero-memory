-- Migration: graded text leg for hybrid memory search (term coverage first)
--
-- Purpose:
--   websearch_to_tsquery ANDs every stem, so the text leg fired only when a
--   document held ALL query terms. That behaves badly in both directions:
--   one divergent word (a translator picking "implementing" where the memory
--   says "introducing") silences the leg entirely, while documents that
--   merely scatter every common stem ("new", "artifact") through unrelated
--   prose still pass the AND gate. Replace the all-or-nothing gate with a
--   graded leg: match with the stems OR-joined, order by how MANY distinct
--   query terms a document covers, then by cover density (matched terms
--   standing close together win the tie). Full-coverage documents keep
--   ranking first by construction; partial overlap now contributes a ranked
--   signal instead of silence.
--
--   Quoted phrases keep their strict <-> semantics for MATCHING (only the
--   top-level joins are relaxed); term coverage only orders the matches.
--
-- Affected objects:
--   - function public.search_memories (CREATE OR REPLACE; body only — same
--     signature and return table as the quality-signals revision)

set search_path = public, extensions;

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
  'marker, quality signals) with a graded text leg: stems OR-joined, matches '
  'ordered by distinct-term coverage then cover density, so full matches '
  'rank first and partial overlap still signals. Security invoker; excludes '
  'invalidated memories.';
