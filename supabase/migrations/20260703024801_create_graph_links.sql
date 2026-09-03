-- Migration: create knowledge-graph link tables
--
-- Purpose:
--   The relational half of the M2 knowledge graph:
--   - public.memory_entities — "this memory mentions this entity",
--   - public.edges — temporal entity->entity relations (Graphiti-style:
--     live rows have invalidated_at is null),
--   - public.memory_links — memory->memory wikilink-style relations.
--
-- Affected objects:
--   - tables: public.memory_entities, public.edges, public.memory_links
--     (+ RLS policies)
--   - indexes: btree (entity_id) on memory_entities; btree (src,type),
--     btree (dst,type), gist (scope), FK covering btrees and a partial
--     unique (src,dst,type) where live on edges; btree (dst) on memory_links
--
-- Special considerations:
--   - memory_entities / memory_links visibility is derived from the
--     underlying memories: the EXISTS subqueries run under the caller's
--     row security, so a link row is only visible when the memory rows
--     themselves are visible (fail-closed by construction).
--   - edges carry their own ltree scope and follow the entities pattern
--     (visible_scopes for read, can_write for write). Edges are ADD-only:
--     "removing" an edge sets invalidated_at via update.
--   - No delete grants/policies for authenticated anywhere here; the
--     on delete cascade clauses only ever fire for service-role deletes.

-- Keep ltree/vector types resolvable while this migration file runs.
-- Session-level `set` (not `set local`): the CLI applies statements outside
-- an explicit transaction block.
set search_path = public, extensions;

-- 1. memory_entities ----------------------------------------------------------

create table public.memory_entities (
  memory_id text not null references public.memories (id) on delete cascade,
  entity_id text not null references public.entities (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (memory_id, entity_id)
);

comment on table public.memory_entities is
  'Mention join: a memory references an entity. Visibility follows the '
  'underlying memory row (RLS EXISTS probe); only the memory owner may link.';

-- Reverse lookups (entity -> memories); the PK already covers memory_id.
create index memory_entities_entity_id_idx
  on public.memory_entities
  using btree (entity_id);

revoke all on public.memory_entities from anon, authenticated;
grant select, insert on public.memory_entities to authenticated;
grant select, insert, update, delete on public.memory_entities to service_role;

alter table public.memory_entities enable row level security;

-- Read: the mention is visible exactly when the underlying memory is.
-- The subquery runs under the caller's RLS on public.memories.
create policy "mentions follow the visibility of their memory"
on public.memory_entities
for select
to authenticated
using (
  exists (
    select 1
    from public.memories
    where memories.id = memory_entities.memory_id
  )
);

-- Write: only the memory owner may attach entities to it.
create policy "memory owners link entities to their memories"
on public.memory_entities
for insert
to authenticated
with check (
  exists (
    select 1
    from public.memories
    where
      memories.id = memory_entities.memory_id
      and memories.owner_id = (select private.current_user_entity_id())
  )
);

-- 2. edges ---------------------------------------------------------------------

create table public.edges (
  id text primary key default public.entity_id_generate('edg')
    check (public.is_entity_id_with_prefix(id, 'edg')),
  src text not null references public.entities (id) on delete cascade,
  dst text not null references public.entities (id) on delete cascade,
  type text not null check (
    type in (
      'uses',
      'works_on',
      'prefers',
      'part_of',
      'depends_on',
      'decided',
      'replaces',
      'relates_to'
    )
  ),
  weight real not null default 1.0,
  scope extensions.ltree not null,
  source_memory text references public.memories (id),
  valid_from timestamptz not null default now(),
  invalidated_at timestamptz,
  created_by text not null default private.current_user_entity_id() references public.profiles (id) check (public.is_entity_id_with_prefix(created_by, 'usr')),
  created_at timestamptz not null default now()
);

comment on table public.edges is
  'Temporal entity->entity relations. A live edge has invalidated_at is '
  'null; edges are never deleted by users, only invalidated (ADD-only). '
  'source_memory records the memory the relation was stated in (provenance).';

-- Traversal fan-out in both directions.
create index edges_src_type_idx
  on public.edges
  using btree (src, type);

create index edges_dst_type_idx
  on public.edges
  using btree (dst, type);

-- Scope subtree checks (ltree ancestor/descendant operators).
create index edges_scope_gist_idx
  on public.edges
  using gist (scope);

-- Covering indexes for foreign keys (advisor lint 0001).
create index edges_source_memory_idx
  on public.edges
  using btree (source_memory);

create index edges_created_by_idx
  on public.edges
  using btree (created_by);

-- At most one LIVE edge per (src, dst, type); history rows (invalidated)
-- may accumulate freely.
create unique index edges_live_src_dst_type_uidx
  on public.edges (src, dst, type)
  where invalidated_at is null;

revoke all on public.edges from anon, authenticated;
grant select, insert, update on public.edges to authenticated;
grant select, insert, update, delete on public.edges to service_role;

alter table public.edges enable row level security;

-- Read: same scope visibility rule as entities/memories.
create policy "members read edges in visible scopes"
on public.edges
for select
to authenticated
using (
  scope = any (((select private.visible_scopes()))::extensions.ltree[])
);

-- Write: rows are always created as yourself, into a writable scope.
create policy "scope writers insert edges"
on public.edges
for insert
to authenticated
with check (
  created_by = (select private.current_user_entity_id())
  and private.can_write(scope)
);

-- Update: scope writers may invalidate (or re-weight) edges in their scopes.
create policy "scope writers update edges"
on public.edges
for update
to authenticated
using ( private.can_write(scope) )
with check ( private.can_write(scope) );

-- Deliberately NO delete policy: edges are invalidated, never deleted.

-- 3. memory_links ----------------------------------------------------------------

create table public.memory_links (
  src text not null references public.memories (id) on delete cascade,
  dst text not null references public.memories (id) on delete cascade,
  type text not null default 'relates_to' check (
    type in ('relates_to', 'supersedes', 'contradicts', 'derived_from')
  ),
  created_at timestamptz not null default now(),
  primary key (src, dst, type)
);

comment on table public.memory_links is
  'Memory->memory relations ([[wikilink]] semantics). Visible only when '
  'both endpoint memories are visible; only the owner of src may link.';

-- Reverse lookups (dst -> srcs); the PK already covers the src prefix.
create index memory_links_dst_idx
  on public.memory_links
  using btree (dst);

revoke all on public.memory_links from anon, authenticated;
grant select, insert on public.memory_links to authenticated;
grant select, insert, update, delete on public.memory_links to service_role;

alter table public.memory_links enable row level security;

-- Read: a link is visible only when BOTH endpoints are visible (the
-- subqueries run under the caller's RLS on public.memories).
create policy "links follow the visibility of both memories"
on public.memory_links
for select
to authenticated
using (
  exists (
    select 1 from public.memories
    where memories.id = memory_links.src
  )
  and exists (
    select 1 from public.memories
    where memories.id = memory_links.dst
  )
);

-- Write: the owner of the source memory may link it to any memory they can
-- SEE (the dst EXISTS probe fails closed on invisible targets).
create policy "src owners link their memories to visible memories"
on public.memory_links
for insert
to authenticated
with check (
  exists (
    select 1
    from public.memories
    where
      memories.id = memory_links.src
      and memories.owner_id = (select private.current_user_entity_id())
  )
  and exists (
    select 1 from public.memories
    where memories.id = memory_links.dst
  )
);
