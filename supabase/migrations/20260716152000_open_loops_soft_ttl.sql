-- Migration: soft-TTL for open loops in the briefing
--
-- Purpose:
--   The open_loops briefing section surfaces every active loop of the briefed
--   scopes, oldest first — so with no expiry the visible cap fills with the
--   stalest, most-abandoned loops while fresh handoffs get pushed into the
--   "+N more" counter. Add a soft TTL: unclosed loops older than N days drop
--   out of the BRIEFING section only. They stay active memories — the
--   /memories feed and direct recall still find them, and closing/superseding
--   them works unchanged. Ranking-time demotion discipline: no invalidation,
--   no deletion, one WHERE on age.
--
-- Affected objects:
--   - function public.build_context (CREATE OR REPLACE; body only — the
--     open_loops / open_loops_total legs gain the age cutoff, signature and
--     output shape unchanged)
--
-- Special considerations:
--   - N is an instance-level knob: the zm.open_loop_ttl_days database setting,
--     read with current_setting(..., missing_ok => true); unset/empty falls
--     back to 14 days. Tune without a deploy:
--       alter database postgres set zm.open_loop_ttl_days = '30';
--     A non-integer value fails the cast loudly rather than being silently
--     ignored.
--   - open_loops_total counts loops INSIDE the TTL window (it captions the
--     open_loops list as "and N more", so it must share the list's window;
--     aged-out loops are deliberately not counted as pending work).
--   - memories_open_loops_idx (scope, created_at) already serves the added
--     created_at range predicate.

set search_path = public, extensions;

create or replace function public.build_context(
  topic_embedding extensions.vector,
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
    -- Soft-TTL window for the open-loops legs: instance knob with a 14-day
    -- default. Evaluated once.
    open_loop_ttl as (
      select coalesce(
        nullif(current_setting('zm.open_loop_ttl_days', true), '')::integer,
        14
      ) as days
    ),
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
      -- Active open loops of the briefed scopes INSIDE the soft-TTL window,
      -- oldest (stalest) first, capped. Deliberately relevance-free: an open
      -- loop surfaces on every briefing until it is closed — or until it ages
      -- out of the window (it then stays recall-queryable, just not nagging).
      select
        memories.id,
        memories.content,
        memories.kind,
        memories.scope::text as scope,
        memories.created_at
      from public.memories, open_loop_ttl
      where
        memories.kind in ('task', 'open-question')
        and memories.invalidated_at is null
        and memories.created_at
          > now() - make_interval(days => open_loop_ttl.days)
        and (
          scope_filter is null
          or array_position(scope_filter, memories.scope) is not null
        )
      order by memories.created_at asc
      limit 10
    ),
    open_loops_count as (
      select count(*) as total
      from public.memories, open_loop_ttl
      where
        memories.kind in ('task', 'open-question')
        and memories.invalidated_at is null
        and memories.created_at
          > now() - make_interval(days => open_loop_ttl.days)
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
  'briefing until closed — or until older than the soft TTL '
  '(zm.open_loop_ttl_days, default 14; aged-out loops stay recall-queryable). '
  'Security invoker: RLS applies throughout.';
