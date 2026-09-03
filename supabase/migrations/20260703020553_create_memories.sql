-- Migration: create memories table
--
-- Purpose:
--   The core ADD-only memory store for zero-memory. Each row is one memory
--   fragment with a 384-dim embedding for semantic search, a generated
--   tsvector for full-text search, an ltree scope, and lifecycle columns for
--   invalidation/supersession instead of deletion.
--
-- Affected objects:
--   - table: public.memories (+ RLS policies)
--   - indexes: hnsw on embedding, gin on fts, gist on scope, btree on owner_id
--
-- Special considerations:
--   - ADD-only: there is deliberately NO delete policy. "Forgetting" a memory
--     sets invalidated_at / invalidated_by via update; history is preserved.
--   - Fail-closed visibility: private rows are owner-only; shared rows are
--     readable only inside scopes admitted by private.visible_scopes().
--   - The fts column is generated from content with the 'simple' config so it
--     stays language-agnostic (multilingual content).

-- Keep ltree/vector types resolvable while this migration file runs.
-- Session-level `set` (not `set local`): the CLI applies statements outside
-- an explicit transaction block. Policies resolve operators at creation time,
-- so plain ltree operators are safe here.
set search_path = public, extensions;

-- 1. table -------------------------------------------------------------------

create table public.memories (
  id text primary key default public.entity_id_generate('mem')
    check (public.is_entity_id_with_prefix(id, 'mem')),
  content text not null,
  kind text not null default 'fact' check (
    kind in (
      'fact',
      'preference',
      'decision',
      'convention',
      'gotcha',
      'reference',
      'episode'
    )
  ),
  embedding extensions.vector (384),
  fts tsvector generated always as (to_tsvector('simple', content)) stored,
  scope extensions.ltree not null,
  visibility text not null default 'private' check (
    visibility in ('private', 'shared')
  ),
  -- usr_ owner: the domain references profiles(id), never auth.users. The
  -- default resolves the caller's usr_ from auth.uid(); RLS below compares the
  -- same way, so ownership stays rooted in the JWT.
  owner_id text not null default private.current_user_entity_id()
    references public.profiles (id)
    check (public.is_entity_id_with_prefix(owner_id, 'usr')),
  author_kind text not null default 'agent' check (
    author_kind in ('human', 'agent')
  ),
  agent_name text,
  source jsonb,
  valid_from timestamptz default now(),
  invalidated_at timestamptz,
  invalidated_by text references public.profiles (id)
    check (invalidated_by is null or public.is_entity_id_with_prefix(invalidated_by, 'usr')),
  superseded_by text references public.memories (id),
  shared_at timestamptz,
  shared_by text references public.profiles (id)
    check (shared_by is null or public.is_entity_id_with_prefix(shared_by, 'usr')),
  created_at timestamptz default now()
);

comment on table public.memories is
  'ADD-only store of memory fragments. A memory is never deleted: it is '
  'invalidated (invalidated_at/invalidated_by) or superseded (superseded_by '
  'points at the replacement). Visibility is private (owner-only) or shared '
  '(readable within the ltree scope, see RLS). The embedding column holds a '
  '384-dim vector; fts is generated from content for hybrid search.';

-- 2. indexes -----------------------------------------------------------------

-- Approximate nearest-neighbour search over embeddings (cosine distance).
create index memories_embedding_hnsw_idx
  on public.memories
  using hnsw (embedding extensions.vector_cosine_ops);

-- Full-text search over the generated tsvector.
create index memories_fts_gin_idx
  on public.memories
  using gin (fts);

-- Scope subtree checks (ltree ancestor/descendant operators).
create index memories_scope_gist_idx
  on public.memories
  using gist (scope);

-- RLS predicates filter on owner_id for every private row.
create index memories_owner_id_idx
  on public.memories
  using btree (owner_id);

-- Covering index for the superseded_by foreign key (advisor lint 0001).
create index memories_superseded_by_idx
  on public.memories
  using btree (superseded_by);

-- Covering indexes for the attribution foreign keys (advisor lint 0001).
create index memories_invalidated_by_idx
  on public.memories
  using btree (invalidated_by);

create index memories_shared_by_idx
  on public.memories
  using btree (shared_by);

-- 3. grants --------------------------------------------------------------------

-- Explicit grants (recent Supabase defaults grant nothing to the API roles).
-- authenticated deliberately gets NO delete: the table is ADD-only and the
-- grant layer backs up the missing delete policy. anon gets nothing.
revoke all on public.memories from anon, authenticated;
grant select, insert, update on public.memories to authenticated;
grant select, insert, update, delete on public.memories to service_role;

-- 4. RLS ----------------------------------------------------------------------

alter table public.memories enable row level security;

-- Fail-closed baseline: anon has no policies and therefore sees nothing.

-- Read: own private rows, or shared rows whose scope the user may see
-- (personal scope, member scopes, ancestors of member scopes).
create policy "owners read private memories and members read shared ones"
on public.memories
for select
to authenticated
using (
  (visibility = 'private' and owner_id = (select private.current_user_entity_id()))
  or (
    visibility = 'shared'
    -- The cast keeps the scalar subquery in expression position (InitPlan,
    -- evaluated once per statement) instead of the ANY-subquery form.
    and scope = any (((select private.visible_scopes()))::extensions.ltree[])
  )
);

-- Write: rows are always inserted as yourself; private rows can target any
-- scope (they stay owner-only), shared rows require write access to the scope.
create policy "owners insert their own memories"
on public.memories
for insert
to authenticated
with check (
  owner_id = (select private.current_user_entity_id())
  and (visibility = 'private' or private.can_write(scope))
);

-- Update: owners manage their rows; scope writers can update shared rows in
-- their scopes (e.g. invalidate an outdated team memory).
create policy "owners and scope writers update memories"
on public.memories
for update
to authenticated
using (
  owner_id = (select private.current_user_entity_id())
  or private.can_write(scope)
)
with check (
  owner_id = (select private.current_user_entity_id())
  or private.can_write(scope)
);

-- Deliberately NO delete policy: the store is ADD-only and deletes must fail
-- for every role except the service role (which bypasses RLS).
