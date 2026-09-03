-- Migration: scope-filter the linked_memories leg of build_context
--
-- Purpose:
--   Project-scope read isolation. build_context already filters its memory
--   hits (via search_memories) and its entity seeds by scope_filter, but the
--   linked_memories leg walked from the selected entities to EVERY visible
--   memory mentioning them — leaking another project's memories into a
--   scope-filtered briefing through the graph. This recreates the function
--   with the same filter applied to that leg.
--
-- Affected objects:
--   - function public.build_context(extensions.vector, text,
--     extensions.ltree[], int, int)   (CREATE OR REPLACE, signature unchanged)
--
-- Special considerations:
--   - Signature, return shape, and grants are unchanged; callers need no
--     changes. scope_filter = null keeps the previous behavior (RLS only).
--   - Idempotent (CREATE OR REPLACE): safe to apply to the live stack.

set search_path = public, extensions;

create or replace function public.build_context(
  topic_embedding extensions.vector (384),
  topic_text text,
  scope_filter extensions.ltree[] default null,
  max_memories int default 12,
  max_entities int default 12
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with
    memory_hits as (
      -- Top hybrid hits for the topic: reuse the RRF pipeline as-is.
      select *
      from public.search_memories(
        topic_embedding, topic_text, scope_filter, max_memories, null
      )
    ),
    seed_entities as (
      -- Entities matched directly by the topic: full-text over names OR
      -- name-embedding cosine similarity.
      select
        entities.id,
        entities.name,
        entities.type,
        coalesce(
          1 - (entities.name_embedding operator(extensions.<=>) topic_embedding),
          0
        )::double precision as similarity
      from public.entities
      where
        (
          scope_filter is null
          -- array_position resolves ltree equality via the type cache (see
          -- search_memories for the empty-search_path rationale).
          or array_position(scope_filter, entities.scope) is not null
        )
        and (
          to_tsvector('simple', entities.name)
            @@ websearch_to_tsquery('simple', topic_text)
          or (
            entities.name_embedding is not null
            and 1 - (
              entities.name_embedding operator(extensions.<=>) topic_embedding
            ) >= 0.6
          )
        )
    ),
    mentioned_entities as (
      -- Entities attached to the top memory hits: keeps the briefing
      -- connected (edges need both endpoints in the entity set).
      select
        entities.id,
        entities.name,
        entities.type,
        0::double precision as similarity
      from
        public.memory_entities
        join memory_hits on memory_hits.id = memory_entities.memory_id
        join public.entities on entities.id = memory_entities.entity_id
    ),
    topic_entities as (
      select distinct on (combined.id)
        combined.id,
        combined.name,
        combined.type,
        combined.similarity
      from (
        select * from seed_entities
        union all
        select * from mentioned_entities
      ) as combined
      order by combined.id, combined.similarity desc
    ),
    top_entities as (
      select *
      from topic_entities
      order by topic_entities.similarity desc, topic_entities.name
      limit greatest(max_entities, 1)
    ),
    live_edges as (
      -- Live edges among the selected entities, endpoints as names.
      select
        src_entity.name as src,
        dst_entity.name as dst,
        edges.type,
        edges.weight
      from
        public.edges
        join top_entities as src_entity on src_entity.id = edges.src
        join top_entities as dst_entity on dst_entity.id = edges.dst
      where edges.invalidated_at is null
    ),
    linked_memories as (
      -- Extra valid memories mentioning the selected entities, excluding
      -- ids already delivered as topic hits. Scope-filtered like the other
      -- legs: without this, the graph walk leaks other projects' memories
      -- into an isolated briefing.
      select distinct
        memories.id,
        memories.content,
        memories.kind,
        memories.scope::text as scope,
        memories.created_at
      from
        public.memory_entities
        join top_entities on top_entities.id = memory_entities.entity_id
        join public.memories on memories.id = memory_entities.memory_id
      where
        memories.invalidated_at is null
        and (
          scope_filter is null
          or array_position(scope_filter, memories.scope) is not null
        )
        and not exists (
          select 1 from memory_hits where memory_hits.id = memories.id
        )
      limit greatest(max_memories, 1)
    )
  select jsonb_build_object(
    'memories', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', memory_hits.id,
            'content', memory_hits.content,
            'kind', memory_hits.kind,
            'scope', memory_hits.scope,
            'created_at', memory_hits.created_at,
            'score', memory_hits.score
          )
          order by memory_hits.score desc, memory_hits.created_at desc
        )
        from memory_hits
      ),
      '[]'::jsonb
    ),
    'entities', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', top_entities.id,
            'name', top_entities.name,
            'type', top_entities.type
          )
          order by top_entities.similarity desc, top_entities.name
        )
        from top_entities
      ),
      '[]'::jsonb
    ),
    'edges', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'src', live_edges.src,
            'dst', live_edges.dst,
            'type', live_edges.type,
            'weight', live_edges.weight
          )
        )
        from live_edges
      ),
      '[]'::jsonb
    ),
    'linked_memories', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', linked_memories.id,
            'content', linked_memories.content,
            'kind', linked_memories.kind,
            'scope', linked_memories.scope,
            'created_at', linked_memories.created_at
          )
        )
        from linked_memories
      ),
      '[]'::jsonb
    )
  );
$$;

comment on function public.build_context(
  extensions.vector, text, extensions.ltree[], int, int
) is
  'One-call context briefing for a topic: hybrid memory hits, entities '
  'matched by name (fts + cosine) plus entities mentioned by those hits, '
  'live edges among them, and extra linked memories (deduplicated against '
  'the hits, scope-filtered like the hits). Security invoker: RLS applies '
  'throughout.';
