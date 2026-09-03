-- Migration: every pack section carries a content cap
--
-- Purpose:
--   MEASURED on a clone of the live corpus (15 briefing packs, k=12): a pack
--   averages 61,471 characters — roughly 15,400 tokens — before the server
--   appends the standing rules. Clients answer by spilling the result to a
--   file and injecting a short preview, so the most valuable payload is the
--   part least likely to be read. The pack is over its channel, not merely
--   expensive.
--
--   Where the characters were: open_loops 35.8%, memories 34.5%, recent 13.6%,
--   linked_memories 13.0%, entities+edges 2.8%. Only `linked_memories` had a
--   content cap; the three largest sections carried FULL text, and a single
--   memory row reached 11,567 characters.
--
--   This gives every section the treatment the linked leg already had: cap the
--   content, flag the row as truncated, and let the caller pull the full text
--   by id through the resource it already has (zm://memory/{id}). Row COUNTS
--   and every ranking decision are untouched — which ids a pack contains does
--   not change, only how much of each is inlined.
--
--   Cap values are chosen from a measured curve, not by feel, and the two
--   halves of the win are very different in price.
--
--   The loop and recent caps are the cheap half: those two sections alone take
--   a pack from 61,471 to 40,304 characters (-34%). A loop in a briefing is a
--   REMINDER that unfinished work exists, not the handover document itself
--   (median loop: 1,798 characters), and `recent` answers "what changed",
--   where a headline is the whole point. 400 characters plus the id carries
--   both.
--
--   The cap on the HITS is the expensive half, because the top hits are what a
--   briefing exists to deliver. Measured against the same 15 packs:
--
--     cap    pack chars   share of hits truncated
--     none      40,304      0.0%
--     2400      37,978     11.7%
--     1800      36,339     33.3%
--     1200      32,796     61.1%
--      800      29,611     72.8%
--
--   Tightening from 1800 to 1200 buys 3.5K characters and nearly doubles the
--   share of cut hits, so 1800 is where this stops: the dense tail of a long
--   memory is trimmed, a typical row (median 230-444 characters by kind)
--   is untouched, and a third of hits carry a flag pointing at the rest.
--
--   The better mechanism for the long tail is stubs — full text for the top
--   rows, pointer plus one line for the rest — which belongs with the graph
--   expansion work that introduces stubs anyway. This migration deliberately
--   does the part that needs no new row shape.
--
--   Effect at these defaults: 61,471 -> ~36,300 characters per pack (-41%),
--   with no change to which memories are delivered.
--
-- Original purpose of this function body (unchanged, kept for the reader):
--   The briefing `recent` leg is relevance-free (pure created_at top-N), so a
--   fresh memory from an UNRELATED project scope surfaces at the very TOP of a
--   briefing — the crudest form of cross-project bleed. Every other leg ranks
--   by topic relevance and merely demotes a foreign-scope hit; the recency leg
--   has no relevance to demote, so a foreign proj.*/team.* memory reads as
--   this project's freshest context when it is nothing of the sort.
--
--   The scope guard on `recent` was `scope_filter is null OR array_position(
--   scope_filter, scope) is not null` — identical to the other legs. The hole
--   is the `scope_filter is null` escape: when a session has no pinned project
--   (no cwd binding / MCP roots), the read degrades to "all visible scopes"
--   (memory.service #readScopes), and the relevance-free recency leg then pulls
--   the freshest memory across EVERY project the caller can see.
--
--   Fix (recency leg only): a memory in a SHAREABLE root (proj.*/project.*/
--   team.*) reaches `recent` ONLY when it is in the briefed scope-set. Memories
--   in the caller's personal subtree (user.* / core) stay unconditionally
--   eligible — a personal note that happens to be about another project is
--   still the caller's own portable working knowledge, intentionally
--   cross-cutting. The ranked legs are deliberately left untouched: they demote
--   (not drop) foreign-scope hits by relevance, and a topic-relevant memory
--   from a related scope is legitimate context. This is a hard exclusion only
--   on the one leg that cannot rank.
--
--   Behavior note: an explicit `scopes: ["*"]` briefing also arrives as
--   scope_filter null (all-scopes), so under this change its recency leg shows
--   personal memories only — the cross-project hits it asked for still arrive
--   through the ranked memory/linked legs. No RPC signature change; the null
--   escape is preserved verbatim for the personal branch.
--
-- Affected objects:
--   - function public.build_context (CREATE OR REPLACE; body only — three new
--     knobs and the content expressions of the `memories`, `open_loops` and
--     `recent` sections; signature, grants, row counts and every ranking
--     decision unchanged).
--
-- Knobs (all optional; a value of 0 disables that section's cap):
--   zm.memory_content_cap_chars integer, default 1200
--   zm.loop_content_cap_chars   integer, default 400
--   zm.recent_content_cap_chars integer, default 400

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
        ) as recent_max,
        -- Per-section content caps. 0 means "no cap" so an operator can
        -- restore the previous shape of any one section without a migration,
        -- which is also how the displacement harness measures the cost of
        -- each cap separately.
        coalesce(
          nullif(
            current_setting('zm.memory_content_cap_chars', true), ''
          )::integer,
          1800
        ) as memory_cap_chars,
        coalesce(
          nullif(
            current_setting('zm.loop_content_cap_chars', true), ''
          )::integer,
          400
        ) as loop_cap_chars,
        coalesce(
          nullif(
            current_setting('zm.recent_content_cap_chars', true), ''
          )::integer,
          400
        ) as recent_cap_chars
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
              when knobs.loop_cap_chars > 0
                and length(open_loops.content) > knobs.loop_cap_chars
                then left(open_loops.content, knobs.loop_cap_chars)
              else open_loops.content
            end,
            'kind', open_loops.kind,
            'scope', open_loops.scope,
            'created_at', open_loops.created_at,
            'truncated',
              knobs.loop_cap_chars > 0
                and length(open_loops.content) > knobs.loop_cap_chars
          )
          order by open_loops.created_at asc
        )
        from open_loops, knobs
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
  'family as the hits (episodes excluded); EVERY section inlines content up '
  'to its own cap and flags the row as truncated past it, the full text '
  'staying one id away (zm.memory_content_cap_chars 1200, '
  'zm.loop_content_cap_chars 400, zm.recent_content_cap_chars 400, '
  'zm.linked_content_cap_chars 600; 0 disables a cap) — row counts and '
  'ranking are unaffected, only how much of each row is inlined; '
  'with briefing => true also `recent` — the scopes'' freshest '
  'AUTHORITATIVE decisions/gotchas/conventions/facts (watcher extractions '
  'excluded; zm.recent_window_days default 14, zm.recent_max default 5) '
  'independent of topic similarity, deduplicated against the ranked legs, '
  'and — because the recency leg cannot rank — restricted to the briefed '
  'scope-set for shareable (proj.*/project.*/team.*) memories so a foreign '
  'project''s freshest note never leads the briefing, while personal '
  '(user.*/core) memories stay cross-cutting; and a hard filter keeping '
  'rules-promoted memories out of the pack (they already arrive via the '
  'rules layer); and the scopes'' ACTIVE open loops (oldest first, cap 10 + '
  'total, soft TTL zm.open_loop_ttl_days default 14). Security invoker: RLS '
  'applies throughout.';
