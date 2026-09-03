-- Migration: open-loop kinds (task / open-question) + briefing surface
--
-- Purpose:
--   Open loops: short-lived lifecycle memories — a handed-over task ("check
--   log X on machine Y") or an unanswered question — that every briefing
--   surfaces ABOVE the ranked pack until explicitly closed (invalidated).
--   This widens the memories.kind vocabulary with the pair task +
--   open-question, gives the briefing selection a hot partial index, and
--   teaches build_context a dedicated open_loops section.
--
-- Affected objects:
--   - table public.memories: kind check constraint widened (additive; no
--     rows are touched, existing kinds all remain valid)
--   - index public.memories_open_loops_idx (new, partial: active open loops)
--   - function public.build_context(extensions.vector, text,
--     extensions.ltree[], int, int)  (CREATE OR REPLACE, signature unchanged;
--     output gains open_loops / open_loops_total keys — additive, older
--     clients strip unknown keys)
--
-- Special considerations:
--   - Open-loop kinds are EXCLUDED from the ranked memories/linked_memories
--     legs: active loops are always delivered via the open_loops section, so
--     letting them also compete in the top-k would duplicate them; closed
--     loops are invalidated and out of every leg (ADD-only history remains).
--   - The open_loops section is capped (10, oldest first) with a total count
--     so callers can render "and N more".
--   - Idempotent-safe: constraint swap in one transaction, CREATE OR REPLACE
--     for the function, IF NOT EXISTS for the index.

set search_path = public, extensions;

-- 1. widen the kind vocabulary ------------------------------------------------

-- The original inline check got the auto-generated name memories_kind_check.
-- Additive swap: every previously-valid kind stays valid, so no row can fail
-- the new constraint and validation is a metadata-only scan.
alter table public.memories
drop constraint memories_kind_check;

alter table public.memories
add constraint memories_kind_check check (
  kind in (
    'fact',
    'preference',
    'decision',
    'convention',
    'gotcha',
    'reference',
    'episode',
    'task',
    'open-question'
  )
);

-- 2. hot partial index for the briefing selection -----------------------------

-- Every briefing lists ACTIVE open loops of the briefed scopes, oldest first.
-- Active loops are few by design (they get closed), so the partial index stays
-- tiny while sparing the briefing a full scan of the memories table.
create index if not exists memories_open_loops_idx
on public.memories (scope, created_at)
where kind in ('task', 'open-question') and invalidated_at is null;

comment on index public.memories_open_loops_idx is
  'Active open loops (kind task/open-question, not invalidated) by scope, '
  'oldest first — the build_context open_loops selection.';

-- 3. build_context: open_loops section ----------------------------------------

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
      -- Open-loop kinds are excluded: active loops always arrive via the
      -- open_loops section below, never through (nor competing for) top-k.
      select *
      from public.search_memories(
        topic_embedding, topic_text, scope_filter, max_memories, null
      )
      where kind not in ('task', 'open-question')
    ),
    open_loops as (
      -- ALL active open loops of the briefed scopes, oldest (stalest) first,
      -- capped. Deliberately relevance-free: an open loop surfaces on every
      -- briefing regardless of topic until it is closed.
      select
        memories.id,
        memories.content,
        memories.kind,
        memories.scope::text as scope,
        memories.created_at
      from public.memories
      where
        memories.kind in ('task', 'open-question')
        and memories.invalidated_at is null
        and (
          scope_filter is null
          or array_position(scope_filter, memories.scope) is not null
        )
      order by memories.created_at asc
      limit 10
    ),
    open_loops_count as (
      select count(*) as total
      from public.memories
      where
        memories.kind in ('task', 'open-question')
        and memories.invalidated_at is null
        and (
          scope_filter is null
          or array_position(scope_filter, memories.scope) is not null
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
      -- into an isolated briefing. Open-loop kinds excluded like the hits.
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
        and memories.kind not in ('task', 'open-question')
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
    ),
    'open_loops', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', open_loops.id,
            'content', open_loops.content,
            'kind', open_loops.kind,
            'scope', open_loops.scope,
            'created_at', open_loops.created_at
          )
          order by open_loops.created_at asc
        )
        from open_loops
      ),
      '[]'::jsonb
    ),
    'open_loops_total', (select open_loops_count.total from open_loops_count)
  );
$$;

comment on function public.build_context(
  extensions.vector, text, extensions.ltree[], int, int
) is
  'One-call context briefing for a topic: hybrid memory hits, entities '
  'matched by name (fts + cosine) plus entities mentioned by those hits, '
  'live edges among them, extra linked memories (deduplicated against the '
  'hits, scope-filtered like the hits), and the scopes'' ACTIVE open loops '
  '(kind task/open-question, oldest first, cap 10 + total) surfaced on every '
  'briefing until closed. Security invoker: RLS applies throughout.';
