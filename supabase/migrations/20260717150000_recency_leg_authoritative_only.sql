-- Migration: recency leg carries authoritative writes only
--
-- Purpose:
--   The first live day of the recency leg showed provisional watcher
--   extractions drowning it: one working session emits dozens of
--   watcher-written facts, and a pure created_at top-N then carries session
--   chatter instead of the owner's working set (27 of the 35 newest durable
--   rows were watcher writes). Everywhere else in the recipe provisional
--   watcher provenance ranks below authoritative; the recency leg — which
--   has no relevance scoring to demote noise — excludes it outright. The
--   watcher's knowledge still reaches briefings through the ranked legs
--   once it proves relevant (and hygiene consolidates or defers it).
--
-- Affected objects:
--   - function public.build_context (CREATE OR REPLACE; body only — the
--     `recent` CTE gains the provenance filter, signature/grants unchanged).

set search_path = public, extensions;

create or replace function public.build_context(
  topic_embedding extensions.vector,
  topic_text text,
  scope_filter extensions.ltree[] default null,
  max_memories int default 12,
  max_entities int default 12,
  briefing boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with
    -- Instance knobs, evaluated once. Non-integer values fail the cast
    -- loudly rather than being silently ignored.
    knobs as (
      select
        coalesce(
          nullif(current_setting('zm.open_loop_ttl_days', true), '')::integer,
          14
        ) as open_loop_ttl_days,
        coalesce(
          nullif(
            current_setting('zm.linked_content_cap_chars', true), ''
          )::integer,
          600
        ) as linked_cap_chars,
        coalesce(
          nullif(current_setting('zm.edge_weight_min', true), '')::double precision,
          1
        ) as edge_weight_min,
        coalesce(
          nullif(current_setting('zm.recent_window_days', true), '')::integer,
          14
        ) as recent_window_days,
        coalesce(
          nullif(current_setting('zm.recent_max', true), '')::integer,
          5
        ) as recent_max
    ),
    -- Memories whose content was promoted into an always-on rules file:
    -- a briefing must not deliver them a second time. Owner-readable RLS
    -- means the caller sees exactly their own promotions.
    promoted as (
      select rc.memory_id
      from public.rule_candidates rc
      where briefing and rc.status = 'promoted'
    ),
    memory_hits as (
      -- Top hybrid hits for the topic: reuse the RRF pipeline as-is.
      -- Open-loop kinds are excluded: active loops always arrive via the
      -- open_loops section below, never through (nor competing for) top-k.
      select *
      from public.search_memories(
        topic_embedding, topic_text, scope_filter, max_memories, null
      )
      where
        kind not in ('task', 'open-question')
        and not exists (
          select 1 from promoted where promoted.memory_id = search_memories.id
        )
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
      from public.memories, knobs
      where
        memories.kind in ('task', 'open-question')
        and memories.invalidated_at is null
        and memories.created_at
          > now() - make_interval(days => knobs.open_loop_ttl_days)
        and (
          scope_filter is null
          or array_position(scope_filter, memories.scope) is not null
        )
      order by memories.created_at asc
      limit 10
    ),
    open_loops_count as (
      select count(*) as total
      from public.memories, knobs
      where
        memories.kind in ('task', 'open-question')
        and memories.invalidated_at is null
        and memories.created_at
          > now() - make_interval(days => knobs.open_loop_ttl_days)
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
      -- Deduplicated by row id, with the display-normalization key: lower
      -- case, separator runs (space/underscore/hyphen) unified — so
      -- "zero_memory", "Zero Memory" and "zero-memory" collapse together.
      select distinct on (combined.id)
        combined.id,
        combined.name,
        combined.type,
        combined.similarity,
        regexp_replace(lower(combined.name), '[_\s-]+', '-', 'g') as norm
      from (
        select * from seed_entities
        union all
        select * from mentioned_entities
      ) as combined
      order by combined.id, combined.similarity desc
    ),
    entity_groups as (
      -- One row per normalized name: representative id/name (best topic
      -- similarity wins), dominant type, the distinct types and the member
      -- count. Collapsing BEFORE the cap keeps duplicates from eating the
      -- entity budget. Data-level merge is entity resolution's job; this is
      -- render hygiene.
      select
        topic_entities.norm,
        (array_agg(topic_entities.id
           order by topic_entities.similarity desc, topic_entities.name,
             topic_entities.id))[1] as id,
        (array_agg(topic_entities.name
           order by topic_entities.similarity desc, topic_entities.name,
             topic_entities.id))[1] as name,
        mode() within group (order by topic_entities.type) as type,
        array_agg(distinct topic_entities.type order by topic_entities.type)
          as types,
        count(*) as members,
        max(topic_entities.similarity) as similarity
      from topic_entities
      group by topic_entities.norm
    ),
    top_entities as (
      select *
      from entity_groups
      order by entity_groups.similarity desc, entity_groups.name
      limit greatest(max_entities, 1)
    ),
    -- Every duplicate row belonging to a selected group: edges and linked
    -- memories attach to the duplicates' ids, so the graph legs walk through
    -- the members while the display shows the collapsed group.
    entity_members as (
      select topic_entities.id, top_entities.norm, top_entities.name
      from topic_entities
      join top_entities on top_entities.norm = topic_entities.norm
    ),
    live_edges as (
      -- Live edges among the selected groups, endpoints as canonical names.
      -- Self-loops by normalized name are dropped (duplicate entities made
      -- them ubiquitous), parallel edges between two groups collapse to one
      -- row (max weight), and sub-floor weights are filtered out.
      select
        src_member.name as src,
        dst_member.name as dst,
        edges.type,
        max(edges.weight) as weight
      from
        public.edges
        join entity_members as src_member on src_member.id = edges.src
        join entity_members as dst_member on dst_member.id = edges.dst
        cross join knobs
      where
        edges.invalidated_at is null
        and src_member.norm <> dst_member.norm
        and edges.weight >= knobs.edge_weight_min
      group by src_member.name, dst_member.name, edges.type
    ),
    linked_candidates as (
      -- Valid memories mentioning the selected entity groups, excluding ids
      -- already delivered as topic hits. Scope-filtered like the other legs;
      -- episodes and open-loop kinds excluded (transient fragments rode this
      -- leg unranked before).
      select distinct
        memories.id,
        memories.content,
        memories.kind,
        memories.scope,
        memories.created_at,
        memories.embedding,
        memories.agent_name
      from
        public.memory_entities
        join entity_members on entity_members.id = memory_entities.entity_id
        join public.memories on memories.id = memory_entities.memory_id
      where
        memories.invalidated_at is null
        and memories.kind not in ('episode', 'task', 'open-question')
        and (
          scope_filter is null
          or array_position(scope_filter, memories.scope) is not null
        )
        and not exists (
          select 1 from memory_hits where memory_hits.id = memories.id
        )
        and not exists (
          select 1 from promoted where promoted.memory_id = memories.id
        )
    ),
    linked_memories as (
      -- One ranker for all legs: the same scoring family as search_memories
      -- (topic similarity × kind profile × decay × provenance trust ×
      -- usage reinforcement), stable order, capped.
      select
        linked_candidates.id,
        linked_candidates.content,
        linked_candidates.kind,
        linked_candidates.scope::text as scope,
        linked_candidates.created_at,
        coalesce(
          1 - (
            linked_candidates.embedding operator(extensions.<=>) topic_embedding
          ),
          0
        )
          * coalesce(cfg.weight, 0.85)
          * exp(
            -ln(2.0)
            * (
              extract(epoch from (now() - linked_candidates.created_at))
                / 86400.0
            )
            / coalesce(cfg.half_life_days, 365.0)
          )
          -- provenance trust: provisional watcher writes rank below authoritative
          * case
            when linked_candidates.agent_name is distinct from 'watcher' then 1.0
            else 0.9
          end
          * coalesce(reinforcement.multiplier, 1.0) as score
      from
        linked_candidates
        left join public.ranking_config as cfg
          on cfg.kind = linked_candidates.kind
        left join public.memory_reinforcement as reinforcement
          on reinforcement.memory_id = linked_candidates.id
      order by score desc, linked_candidates.created_at desc
      limit greatest(max_memories, 1)
    ),
    recent as (
      -- The recency leg, briefings only: the scope's freshest live working-
      -- set knowledge by created_at, independent of topic similarity ("what
      -- changed since the last visit"). AUTHORITATIVE writes only: one
      -- session emits dozens of provisional watcher extractions, and a pure
      -- created_at top-N has no relevance scoring to demote that chatter —
      -- watcher knowledge reaches briefings through the ranked legs instead.
      -- Deduplicated against both ranked legs; rules-promoted memories
      -- excluded like everywhere else in a briefing.
      select
        memories.id,
        memories.content,
        memories.kind,
        memories.scope::text as scope,
        memories.created_at
      from public.memories, knobs
      where
        briefing
        and memories.invalidated_at is null
        and memories.kind in ('decision', 'gotcha', 'convention', 'fact')
        and memories.agent_name is distinct from 'watcher'
        and memories.created_at
          > now() - make_interval(days => knobs.recent_window_days)
        and (
          scope_filter is null
          or array_position(scope_filter, memories.scope) is not null
        )
        and not exists (
          select 1 from memory_hits where memory_hits.id = memories.id
        )
        and not exists (
          select 1 from linked_memories
          where linked_memories.id = memories.id
        )
        and not exists (
          select 1 from promoted where promoted.memory_id = memories.id
        )
      order by memories.created_at desc
      limit (select knobs.recent_max from knobs)
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
            'type', top_entities.type,
            'types', to_jsonb(top_entities.types),
            'count', top_entities.members
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
            'content', case
              when length(linked_memories.content) > knobs.linked_cap_chars
                then left(linked_memories.content, knobs.linked_cap_chars)
              else linked_memories.content
            end,
            'kind', linked_memories.kind,
            'scope', linked_memories.scope,
            'created_at', linked_memories.created_at,
            'score', linked_memories.score,
            'truncated',
              length(linked_memories.content) > knobs.linked_cap_chars
          )
          order by linked_memories.score desc, linked_memories.created_at desc
        )
        from linked_memories, knobs
      ),
      '[]'::jsonb
    ),
    'recent', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', recent.id,
            'content', recent.content,
            'kind', recent.kind,
            'scope', recent.scope,
            'created_at', recent.created_at
          )
          order by recent.created_at desc
        )
        from recent
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
  extensions.vector, text, extensions.ltree[], int, int, boolean
) is
  'One-call context briefing for a topic: hybrid memory hits; entities '
  'matched by name (fts + cosine) plus entities mentioned by those hits, '
  'duplicates collapsed by normalized name; live edges among the collapsed '
  'groups (self-loops dropped); linked memories ranked by the same scoring '
  'family as the hits (episodes excluded, over-long content truncated with '
  'a flag); with briefing => true also `recent` — the scopes'' freshest '
  'AUTHORITATIVE decisions/gotchas/conventions/facts (watcher extractions '
  'excluded; zm.recent_window_days default 14, zm.recent_max default 5) '
  'independent of topic similarity, deduplicated against the ranked legs — '
  'and a hard filter keeping rules-promoted memories out of the pack (they '
  'already arrive via the rules layer); and the scopes'' ACTIVE open loops '
  '(oldest first, cap 10 + total, soft TTL zm.open_loop_ttl_days default '
  '14). Security invoker: RLS applies throughout.';
