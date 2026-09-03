-- Migration: the open-loops section spends its budget where the topic points
--
-- Purpose:
--   Open loops are how one session hands work to the next, and the briefing
--   was delivering a fifth of each one. Measured on a production clone: ten
--   loops per pack, mean 2091 characters, capped uniformly at 400 — 20.6% of
--   the text arrives. The memories section, for contrast, delivers 96% at its
--   own cap, so the loss is concentrated almost entirely here.
--
--   Worse, the fifth that arrives is always the OPENING. A handover record
--   states the situation first and what to do on return last, so a uniform
--   head-truncation drops the actionable half by construction.
--
--   Raising the cap for everyone is not the answer: ten full loops cost 20,907
--   characters against today's 4,000, which would undo most of the section
--   caps that brought the pack from 48-68K down to 27-42K. So the budget is
--   spent UNEVENLY instead — the loops NEAREST the topic arrive whole, the
--   rest keep their headline.
--
--   "Nearest" is deliberately a rank, not a threshold: there is no calibrated
--   similarity floor to justify one, so with a single open loop that loop is
--   always the near one and always arrives whole. The cost of being wrong is
--   bounded by the ceiling below, and an uncalibrated floor would be a worse
--   answer than none.
--
-- Affected objects:
--   - function public.build_context (create or replace; body only)
--
-- Special considerations:
--   - SELECTION AND ORDER ARE UNCHANGED and stay relevance-free: still the ten
--     oldest live loops inside the soft-TTL window, still oldest first. A loop
--     surfaces on every briefing until it is closed; relevance decides only how
--     much of it arrives. Nothing can be pushed out of sight by being off-topic.
--   - Ranking uses the record's CLOSEST embedding window rather than its
--     primary vector alone, so a loop whose relevant part sits past its opening
--     is ranked by that part. Without the windows this ranking would see only
--     the same opening the old cap already delivered.
--   - A null topic embedding focuses nothing: every loop keeps the stub cap,
--     which is exactly the previous behaviour.
--   - Worst-case section growth is bounded and small: one focused loop at its
--     own 2400 ceiling plus nine stubs is 6,000 characters against 4,000.
--     zm.loop_focus_count = 0 restores the uniform behaviour exactly.
--   - The `truncated` flag now reflects the cap actually applied to that row,
--     so a focused loop reports false and the pack stays self-describing. No
--     new field is added — the contract shape is unchanged.

set search_path = public, extensions;

create or replace function public.build_context(topic_embedding vector, topic_text text, scope_filter ltree[] DEFAULT NULL::ltree[], max_memories integer DEFAULT 12, max_entities integer DEFAULT 12, briefing boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
        ) as recent_max,
        -- Per-section content caps. 0 means "no cap" so an operator can
        -- restore the previous shape of any one section without a migration,
        -- which is also how the displacement harness measures the cost of
        -- each cap separately.
        coalesce(
          nullif(
            current_setting('zm.memory_content_cap_chars', true), ''
          )::integer,
          2400
        ) as memory_cap_chars,
        coalesce(
          nullif(
            current_setting('zm.loop_content_cap_chars', true), ''
          )::integer,
          400
        ) as loop_cap_chars,
        -- How many of the listed loops arrive WHOLE rather than as a headline.
        -- 0 restores the uniform-stub behaviour this replaces.
        coalesce(
          nullif(current_setting('zm.loop_focus_count', true), '')::integer,
          1
        ) as loop_focus_count,
        -- Ceiling for a focused loop, so one enormous record cannot swallow
        -- the pack. Matches the memories section's cap deliberately.
        coalesce(
          nullif(
            current_setting('zm.loop_focus_cap_chars', true), ''
          )::integer,
          2400
        ) as loop_focus_cap_chars,
        coalesce(
          nullif(
            current_setting('zm.recent_content_cap_chars', true), ''
          )::integer,
          400
        ) as recent_cap_chars,
        -- How many of the linked leg's rows relations may claim. Set to 0 and
        -- the graph leg disappears without touching anything else.
        coalesce(
          nullif(
            current_setting('zm.graph_reserved_rows', true), ''
          )::integer,
          2
        ) as graph_reserved_rows,
        -- Per PARENT hit, not global: one densely linked memory must not spend
        -- the whole reservation on its own neighbourhood.
        coalesce(
          nullif(
            current_setting('zm.graph_neighbors_per_hit', true), ''
          )::integer,
          2
        ) as graph_neighbors_per_hit,
        -- Relation weights, as a fraction of the parent hit's score. They rank
        -- neighbours against EACH OTHER for the reserved rows; comparing them
        -- with the entity leg's similarity scores is meaningless (different
        -- scales), which is why the reservation exists at all.
        coalesce(
          nullif(
            current_setting('zm.graph_weight_supersedes', true), ''
          )::double precision,
          0.9
        ) as graph_weight_supersedes,
        coalesce(
          nullif(
            current_setting('zm.graph_weight_contradicts', true), ''
          )::double precision,
          0.9
        ) as graph_weight_contradicts,
        coalesce(
          nullif(
            current_setting('zm.graph_weight_derived_from', true), ''
          )::double precision,
          0.7
        ) as graph_weight_derived_from,
        coalesce(
          nullif(
            current_setting('zm.graph_weight_relates_to', true), ''
          )::double precision,
          0.5
        ) as graph_weight_relates_to
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
    open_loops_selected as (
      -- Active open loops of the briefed scopes INSIDE the soft-TTL window,
      -- oldest (stalest) first. SELECTION AND ORDER STAY RELEVANCE-FREE: an
      -- open loop surfaces on every briefing until it is closed — or until it
      -- ages out of the window (it then stays recall-queryable, just not
      -- nagging). Only how MUCH of each one arrives varies, below.
      select
        memories.id,
        memories.content,
        memories.kind,
        memories.scope::text as scope,
        memories.created_at,
        -- Distance to the topic over the record's CLOSEST embedding window, so
        -- a loop whose relevant part sits past its opening is ranked by that
        -- part. Null topic = no focus at all (every loop keeps the stub cap).
        case
          when topic_embedding is null then null
          else least(
            memories.embedding operator(extensions.<=>) topic_embedding,
            coalesce(
              (
                select min(
                  chunks.embedding operator(extensions.<=>) topic_embedding
                )
                from public.memory_chunks as chunks
                where chunks.memory_id = memories.id
              ),
              2
            )
          )
        end as topic_distance
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
    open_loops_ranked as (
      select
        open_loops_selected.*,
        row_number() over (
          order by open_loops_selected.topic_distance asc nulls last
        ) as focus_rank
      from open_loops_selected
    ),
    open_loops as (
      -- The section's budget spent unevenly: the loops NEAREST the topic
      -- arrive whole, the rest keep their headline. Uniform stubs
      -- delivered a fifth of a handover record and always its opening, while
      -- what to do next is written at the end.
      select
        open_loops_ranked.id,
        open_loops_ranked.content,
        open_loops_ranked.kind,
        open_loops_ranked.scope,
        open_loops_ranked.created_at,
        case
          when open_loops_ranked.topic_distance is not null
            and open_loops_ranked.focus_rank <= knobs.loop_focus_count
            then knobs.loop_focus_cap_chars
          else knobs.loop_cap_chars
        end as cap_chars
      from open_loops_ranked, knobs
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
    link_edges as (
      -- Typed links touching a hit, BOTH directions: what the hit points at,
      -- and what points at the hit. Direction carries meaning but not
      -- priority — a superseded predecessor explains what changed, and a
      -- superseding successor means the reader is looking at a stale fact.
      select
        memory_hits.id as parent_id,
        memory_hits.score as parent_score,
        memory_links.dst as neighbor_id,
        memory_links.type
      from memory_hits
        join public.memory_links on memory_links.src = memory_hits.id
      union all
      select
        memory_hits.id,
        memory_hits.score,
        memory_links.src,
        memory_links.type
      from memory_hits
        join public.memory_links on memory_links.dst = memory_hits.id
    ),
    link_scored as (
      -- Parent score × relation weight, then the per-parent fan-out cap. The
      -- id tie-break is arbitrary but STABLE: one corpus and one set of knobs
      -- always yield the same pack.
      select
        scored.neighbor_id,
        scored.score,
        row_number() over (
          partition by scored.parent_id
          order by scored.score desc, scored.neighbor_id
        ) as rank_in_parent
      from (
        select
          link_edges.parent_id,
          link_edges.neighbor_id,
          link_edges.parent_score
            * case link_edges.type
              when 'supersedes' then knobs.graph_weight_supersedes
              when 'contradicts' then knobs.graph_weight_contradicts
              when 'derived_from' then knobs.graph_weight_derived_from
              else knobs.graph_weight_relates_to
            end as score
        from link_edges cross join knobs
      ) as scored
    ),
    graph_selected as (
      -- The reserved rows: neighbours that survived the fan-out cap, under
      -- exactly the filters the entity leg applies, best relation first. A
      -- neighbour of several hits keeps its best score.
      select
        memories.id,
        memories.content,
        memories.kind,
        memories.scope::text as scope,
        memories.created_at,
        max(link_scored.score) as score
      from
        link_scored
        join public.memories on memories.id = link_scored.neighbor_id
        cross join knobs
      where
        link_scored.rank_in_parent <= knobs.graph_neighbors_per_hit
        and memories.invalidated_at is null
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
      group by
        memories.id,
        memories.content,
        memories.kind,
        memories.scope,
        memories.created_at
      order by score desc, memories.created_at desc
      limit greatest((select knobs.graph_reserved_rows from knobs), 0)
    ),
    entity_linked as (
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
    linked_memories as (
      -- THE DISPLACEMENT POINT. The leg still emits `max_memories` rows: the
      -- graph takes its reserved share first, the entity leg fills the rest,
      -- and an unclaimed reservation goes back to the entity leg — a corpus
      -- with no links yields exactly the pack it always did. The two sets are
      -- NOT re-ranked against each other afterwards, because their scores are
      -- not comparable; a graph row earns its place by being a declared
      -- relation of something the topic actually matched.
      select id, content, kind, scope, created_at, score from graph_selected
      union all
      (
        select id, content, kind, scope, created_at, score
        from entity_linked
        where not exists (
          select 1
          from graph_selected
          where graph_selected.id = entity_linked.id
        )
        order by score desc, created_at desc
        -- Explicitly "fill the remainder" rather than "rank everything and
        -- cut": one more ORDER BY over the union would sort the graph rows
        -- out again, since their scores live on the smaller RRF scale.
        limit greatest(
          greatest(max_memories, 1) - (select count(*) from graph_selected),
          0
        )
      )
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
          -- Non-shareable (personal) scopes are intentionally cross-cutting:
          -- always eligible for recency, even the null-scope_filter degrade
          -- (no pinned project) — a personal note about another project is
          -- still the caller's own portable knowledge. Shareable proj.*/
          -- project.*/team.* memories reach this relevance-free leg ONLY when
          -- they are in the briefed scope-set; that closes the crude leak
          -- where a session with no pinned project put another project's
          -- freshest memory at the top of the briefing. The ranked legs still
          -- carry topic-relevant cross-scope hits (demoted, not dropped).
          extensions.subpath(memories.scope, 0, 1)::text
            not in ('proj', 'project', 'team')
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
            'content', case
              when knobs.memory_cap_chars > 0
                and length(memory_hits.content) > knobs.memory_cap_chars
                then left(memory_hits.content, knobs.memory_cap_chars)
              else memory_hits.content
            end,
            'kind', memory_hits.kind,
            'scope', memory_hits.scope,
            'created_at', memory_hits.created_at,
            'score', memory_hits.score,
            'truncated',
              knobs.memory_cap_chars > 0
                and length(memory_hits.content) > knobs.memory_cap_chars
          )
          order by memory_hits.score desc, memory_hits.created_at desc
        )
        from memory_hits, knobs
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
            'content', case
              when knobs.recent_cap_chars > 0
                and length(recent.content) > knobs.recent_cap_chars
                then left(recent.content, knobs.recent_cap_chars)
              else recent.content
            end,
            'kind', recent.kind,
            'scope', recent.scope,
            'created_at', recent.created_at,
            'truncated',
              knobs.recent_cap_chars > 0
                and length(recent.content) > knobs.recent_cap_chars
          )
          order by recent.created_at desc
        )
        from recent, knobs
      ),
      '[]'::jsonb
    ),
    'open_loops', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', open_loops.id,
            'content', case
              when open_loops.cap_chars > 0
                and length(open_loops.content) > open_loops.cap_chars
                then left(open_loops.content, open_loops.cap_chars)
              else open_loops.content
            end,
            'kind', open_loops.kind,
            'scope', open_loops.scope,
            'created_at', open_loops.created_at,
            'truncated',
              open_loops.cap_chars > 0
                and length(open_loops.content) > open_loops.cap_chars
          )
          order by open_loops.created_at asc
        )
        from open_loops, knobs
      ),
      '[]'::jsonb
    ),
    'open_loops_total', (select open_loops_count.total from open_loops_count)
  );
$function$

;
