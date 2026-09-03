-- Migration: create entities table
--
-- Purpose:
--   Knowledge-graph nodes for the M2 milestone. An entity is a named thing
--   (person, project, tool, ...) memories talk about. Names are normalized
--   into a generated column so entity resolution can probe for exact matches,
--   and a 384-dim name embedding supports fuzzy resolution (cosine >= 0.85).
--
-- Affected objects:
--   - table: public.entities (+ RLS policies)
--   - indexes: unique (normalized_name, type, scope), gist on scope,
--     hnsw on name_embedding, btree on created_by (FK covering)
--
-- Special considerations:
--   - normalized_name is a generated column (lower + trim + collapsed
--     whitespace) so normalization can never drift from the stored name.
--   - Same fail-closed scope model as public.memories: rows are visible only
--     inside scopes admitted by private.visible_scopes(); writes require
--     private.can_write(scope) (which already admits the personal scope).
--   - No delete grant/policy for authenticated: graph nodes follow the
--     ADD-only posture of the store; cleanup is a service-role concern.

-- Keep ltree/vector types resolvable while this migration file runs.
-- Session-level `set` (not `set local`): the CLI applies statements outside
-- an explicit transaction block.
set search_path = public, extensions;

-- 1. table -------------------------------------------------------------------

create table public.entities (
  id text primary key default public.entity_id_generate('ent')
    check (public.is_entity_id_with_prefix(id, 'ent')),
  name text not null,
  -- Normalization is owned by the database: lowercase, trimmed, inner
  -- whitespace collapsed. regexp_replace(text,text,text,text) is immutable.
  normalized_name text not null generated always as (
    lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))
  ) stored,
  type text not null default 'concept' check (
    type in (
      'person',
      'project',
      'repo',
      'package',
      'service',
      'tool',
      'library',
      'concept'
    )
  ),
  name_embedding extensions.vector (384),
  scope extensions.ltree not null,
  created_by text not null default private.current_user_entity_id() references public.profiles (id) check (public.is_entity_id_with_prefix(created_by, 'usr')),
  created_at timestamptz not null default now(),
  -- One entity per (normalized name, type) inside a scope: the exact-match
  -- step of entity resolution relies on this invariant.
  unique (normalized_name, type, scope)
);

comment on table public.entities is
  'Knowledge-graph nodes: named things (person, project, tool, ...) that '
  'memories mention. normalized_name is generated (lower/trim/collapse '
  'spaces) and unique per (type, scope); name_embedding (384-dim) backs '
  'fuzzy entity resolution.';

-- 2. indexes -----------------------------------------------------------------

-- Scope subtree checks (ltree ancestor/descendant operators).
create index entities_scope_gist_idx
  on public.entities
  using gist (scope);

-- Approximate nearest-neighbour probe over name embeddings (cosine).
create index entities_name_embedding_hnsw_idx
  on public.entities
  using hnsw (name_embedding extensions.vector_cosine_ops);

-- Covering index for the created_by foreign key (advisor lint 0001).
create index entities_created_by_idx
  on public.entities
  using btree (created_by);

-- 3. grants ------------------------------------------------------------------

-- Explicit grants (recent Supabase defaults grant nothing to the API roles).
-- authenticated deliberately gets NO delete: graph nodes are ADD-only.
revoke all on public.entities from anon, authenticated;
grant select, insert, update on public.entities to authenticated;
grant select, insert, update, delete on public.entities to service_role;

-- 4. RLS ---------------------------------------------------------------------

alter table public.entities enable row level security;

-- Fail-closed baseline: anon has no policies and therefore sees nothing.

-- Read: entities are visible inside scopes the user may see (personal scope,
-- member scopes, ancestors of member scopes) — same pattern as memories.
create policy "members read entities in visible scopes"
on public.entities
for select
to authenticated
using (
  -- The cast keeps the scalar subquery in expression position (InitPlan,
  -- evaluated once per statement) instead of the ANY-subquery form.
  scope = any (((select private.visible_scopes()))::extensions.ltree[])
);

-- Write: rows are always created as yourself, into a writable scope.
-- private.can_write already admits the personal scope `user.<uid>`.
create policy "scope writers insert entities"
on public.entities
for insert
to authenticated
with check (
  created_by = (select private.current_user_entity_id())
  and private.can_write(scope)
);

-- Update: scope writers may adjust an entity (e.g. refresh its embedding).
create policy "scope writers update entities"
on public.entities
for update
to authenticated
using ( private.can_write(scope) )
with check ( private.can_write(scope) );

-- Deliberately NO delete policy: nodes are ADD-only for authenticated users;
-- hard cleanup is reserved to the service role (bypasses RLS).
