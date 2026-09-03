-- Migration: create knowledge-graph functions
--
-- Purpose:
--   Read-side RPCs of the M2 knowledge graph:
--   - public.find_similar_entity: name-embedding cosine probe used by the
--     deterministic entity-resolution step (DESIGN §6.6, threshold 0.85).
--   - public.traverse_entities: depth-limited (hard cap 3), cycle-safe
--     recursive walk over LIVE edges in both directions.
--   - public.build_context: one-call context briefing for a topic — top
--     hybrid memory hits + topic entities + live edges among them + extra
--     memories linked to those entities.
--
-- Affected objects:
--   - functions: public.find_similar_entity, public.traverse_entities,
--     public.build_context
--
-- Special considerations:
--   - All three are SECURITY INVOKER on purpose: they only read RLS-guarded
--     tables (entities, edges, memories, memory_entities), so row security
--     keeps scoping every result to the caller.
--   - search_path is pinned to '' and every object/operator is fully
--     qualified (ltree/vector operators live in the extensions schema).
--   - Being authenticated-callable RPCs in the public schema is intended:
--     they are the read API of the graph (accepted, documented residue per
--     the create-migration rule).
--   - Invalidated rows (memories and edges) are always excluded.

-- 1. entity resolution probe ---------------------------------------------------

create or replace function public.find_similar_entity(
  query_embedding extensions.vector (384),
  entity_type text,
  scope_filter extensions.ltree,
  threshold float default 0.85
)
returns table (
  id text,
  name text,
  type text,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    entities.id,
    entities.name,
    entities.type,
    1 - (entities.name_embedding operator(extensions.<=>) query_embedding)
      as similarity
  from public.entities
  where
    entities.name_embedding is not null
    and entities.type = entity_type
    and entities.scope operator(extensions.=) scope_filter
    and 1 - (entities.name_embedding operator(extensions.<=>) query_embedding)
      >= threshold
  order by entities.name_embedding operator(extensions.<=>) query_embedding
  limit 1;
$$;

comment on function public.find_similar_entity(
  extensions.vector, text, extensions.ltree, float
) is
  'Returns the single most name-similar entity of the given type in the '
  'exact scope when its cosine similarity reaches the threshold (0.85 '
  'default). Deterministic entity-resolution probe. Security invoker: RLS '
  'applies.';

-- 2. graph traversal -------------------------------------------------------------

create or replace function public.traverse_entities(
  start_entity text,
  max_depth int default 2,
  edge_types text[] default null
)
returns table (
  entity_id text,
  name text,
  type text,
  depth int,
  via_edge_type text,
  path text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive walk as (
    -- Depth 0: the start node itself (no incoming edge).
    select
      entities.id as entity_id,
      entities.name,
      entities.type,
      0 as depth,
      null::text as via_edge_type,
      array[entities.id] as path
    from public.entities
    where entities.id = start_entity

    union all

    -- Follow LIVE edges in both directions; the path array makes the walk
    -- cycle-safe, and the depth guard is hard-capped at 3 hops.
    select
      next_entity.id,
      next_entity.name,
      next_entity.type,
      walk.depth + 1,
      edges.type,
      walk.path || next_entity.id
    from
      walk
      join public.edges
        on edges.invalidated_at is null
        and (edges.src = walk.entity_id or edges.dst = walk.entity_id)
        and (edge_types is null or edges.type = any (edge_types))
      join public.entities as next_entity
        on next_entity.id = case
          when edges.src = walk.entity_id then edges.dst
          else edges.src
        end
    where
      walk.depth < least(greatest(max_depth, 0), 3)
      and not next_entity.id = any (walk.path)
  )
  select
    walk.entity_id,
    walk.name,
    walk.type,
    walk.depth,
    walk.via_edge_type,
    walk.path
  from walk;
$$;

comment on function public.traverse_entities(text, int, text[]) is
  'Cycle-safe recursive walk over live edges (both directions) starting at '
  'an entity, depth-limited with a hard cap of 3. Returns the start node at '
  'depth 0 plus every reachable node with the edge type it was reached '
  'through and the full uuid path. Security invoker: RLS filters both the '
  'edges and the entities the caller may not see.';

-- 3. context briefing -------------------------------------------------------------

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
      -- ids already delivered as topic hits.
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
  'the hits). Security invoker: RLS applies throughout.';

-- 4. privileges -------------------------------------------------------------------

-- The graph read API is for signed-in users only; anon must not probe it.
revoke all on function public.find_similar_entity(
  extensions.vector, text, extensions.ltree, float
) from public, anon;
revoke all on function public.traverse_entities(text, int, text[])
  from public, anon;
revoke all on function public.build_context(
  extensions.vector, text, extensions.ltree[], int, int
) from public, anon;

grant execute on function public.find_similar_entity(
  extensions.vector, text, extensions.ltree, float
) to authenticated;
grant execute on function public.traverse_entities(text, int, text[])
  to authenticated;
grant execute on function public.build_context(
  extensions.vector, text, extensions.ltree[], int, int
) to authenticated;
