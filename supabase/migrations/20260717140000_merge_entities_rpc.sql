-- Migration: merge_entities — atomic duplicate-entity merge for hygiene
--
-- Purpose:
--   Ingest historically created the same real-world thing many times (the
--   same name under several types and spellings), and the graph legs of the
--   briefing expand through those duplicates. The hygiene cycle now merges
--   each duplicate cluster into its canonical entity. The mutation must be
--   atomic — repoint mentions, repoint edges, drop self-loops, retype and
--   delete duplicates — so it lives in one SQL function the (service-role)
--   hygiene pass calls per cluster.
--
-- Affected objects:
--   - function public.merge_entities(text, text[], text) (new): server-only
--     (service_role execute; hygiene is the only caller).
--
-- Special considerations:
--   - Deliberately NOT owner-facing: no grants to authenticated. The hygiene
--     pass decides WHAT to merge (exact canonical-name clusters only, per
--     the false-invalidation lessons); this function only executes the
--     mechanics and never chooses candidates itself.
--   - Duplicate entity rows are DELETED (graph nodes are structural, not
--     knowledge): the memories that mentioned them keep their mentions via
--     the canonical entity, and the audit_log entry the caller writes
--     records the merge (names, ids, counts) for traceability.
--   - Edges are repointed with `on conflict do nothing` against the live
--     (src, dst, type) uniqueness, so a parallel edge that already exists on
--     the canonical node absorbs the duplicate's edge; edges that would
--     become self-loops are dropped by construction.

set search_path = public, extensions;

create or replace function public.merge_entities(
  p_canonical text,
  p_duplicates text[],
  p_type text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_scope extensions.ltree;
  v_mentions_moved integer := 0;
  v_edges_moved integer := 0;
  v_edges_dropped integer := 0;
  v_deleted integer := 0;
begin
  if p_canonical = any (p_duplicates) then
    raise exception 'merge_entities: canonical % listed as duplicate',
      p_canonical;
  end if;

  select entities.scope into v_scope
  from public.entities
  where entities.id = p_canonical;
  if v_scope is null then
    raise exception 'merge_entities: canonical % not found', p_canonical;
  end if;

  -- Scope guard: a merge never crosses scopes (scope isolation is a read
  -- AND write invariant; cross-scope duplicates stay separate entities).
  if exists (
    select 1
    from public.entities
    where
      entities.id = any (p_duplicates)
      and entities.scope operator(extensions.<>) v_scope
  ) then
    raise exception 'merge_entities: duplicates must share the canonical scope';
  end if;

  -- 1. Mentions: give every memory that mentioned a duplicate the canonical
  -- mention (idempotent), the duplicates' own rows go with the entity delete.
  with moved as (
    insert into public.memory_entities (memory_id, entity_id)
    select distinct memory_entities.memory_id, p_canonical
    from public.memory_entities
    where memory_entities.entity_id = any (p_duplicates)
    on conflict do nothing
    returning 1
  )
  select count(*) into v_mentions_moved from moved;

  -- 2. Edges: recreate each live duplicate edge against the canonical node
  -- (self-loops-by-merge skipped; an existing parallel edge absorbs the
  -- copy), then drop the duplicates' edges (cascade would do it on delete,
  -- the explicit delete keeps the counters honest).
  with moved as (
    insert into public.edges
      (src, dst, type, weight, scope, source_memory, created_by)
    select
      case when edges.src = any (p_duplicates) then p_canonical
        else edges.src end,
      case when edges.dst = any (p_duplicates) then p_canonical
        else edges.dst end,
      edges.type,
      edges.weight,
      edges.scope,
      edges.source_memory,
      edges.created_by
    from public.edges
    where
      edges.invalidated_at is null
      and (
        edges.src = any (p_duplicates)
        or edges.dst = any (p_duplicates)
      )
      and (
        case when edges.src = any (p_duplicates) then p_canonical
          else edges.src end
      ) <> (
        case when edges.dst = any (p_duplicates) then p_canonical
          else edges.dst end
      )
    on conflict do nothing
    returning 1
  )
  select count(*) into v_edges_moved from moved;

  with dropped as (
    delete from public.edges
    where
      edges.src = any (p_duplicates)
      or edges.dst = any (p_duplicates)
    returning 1
  )
  select count(*) into v_edges_dropped from dropped;

  -- Self-loops the merge itself exposes on the canonical node (an edge that
  -- already pointed canonical->duplicate becomes canonical->canonical only
  -- via the insert above, which skips it — but drop any pre-existing ones
  -- for good measure).
  delete from public.edges
  where edges.src = p_canonical and edges.dst = p_canonical;

  -- 3. Dominant type onto the canonical node (the caller computes it from
  -- the cluster; null keeps the canonical's current type).
  if p_type is not null then
    update public.entities
    set type = p_type
    where entities.id = p_canonical;
  end if;

  -- 4. Delete the duplicates (mention rows cascade).
  with gone as (
    delete from public.entities
    where entities.id = any (p_duplicates)
    returning 1
  )
  select count(*) into v_deleted from gone;

  return jsonb_build_object(
    'mentions_moved', v_mentions_moved,
    'edges_moved', v_edges_moved,
    'edges_dropped', v_edges_dropped,
    'duplicates_deleted', v_deleted
  );
end;
$$;

comment on function public.merge_entities(text, text[], text) is
  'Atomically merges duplicate entities into a canonical one: repoints '
  'memory mentions and live edges (skipping would-be self-loops, absorbing '
  'parallels), optionally retypes the canonical to the cluster''s dominant '
  'type, and deletes the duplicate nodes. Server-only mechanics: the hygiene '
  'pass picks the clusters (exact canonical-name matches auto-merge; anything '
  'fuzzier needs a human) and writes the audit_log entry.';

revoke all on function public.merge_entities(text, text[], text)
  from public, anon, authenticated;
grant execute on function public.merge_entities(text, text[], text)
  to service_role;
