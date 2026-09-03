-- Migration: create memory scope infrastructure
--
-- Purpose:
--   Foundation for the zero-memory scope model. Installs the `vector` and
--   `ltree` extensions, a non-exposed `private` schema for RLS helper
--   functions, and the `scope_members` table that records which user belongs
--   to which scope subtree with which role.
--
-- Affected objects:
--   - extensions: vector, ltree (schema `extensions`)
--   - schema: private
--   - functions: private.personal_scope(), private.visible_scopes(),
--     private.can_write(extensions.ltree), private.is_scope_admin(extensions.ltree)
--   - table: public.scope_members (+ RLS policies, gist index)
--
-- Special considerations:
--   - Helper functions are `security definer` so RLS policies can consult
--     scope membership without recursing into `scope_members` policies. They
--     live in the `private` schema, which is NOT exposed through PostgREST,
--     so they are never REST-callable (see create-migration rule).
--   - Every definer function pins `search_path = ''` and fully qualifies
--     object references.
--   - For milestone M1 `scope_members` may stay empty: the personal scope
--     `user.<uid>` is derived from `auth.uid()` and always works.

-- Migration DDL below parses ltree operators/types; keep extensions schema
-- resolvable while the file runs (functions still pin their own search_path).
-- Session-level `set` (not `set local`): the CLI applies statements outside
-- an explicit transaction block.
set search_path = public, extensions;

-- 1. extensions -------------------------------------------------------------

create extension if not exists vector with schema extensions;
create extension if not exists ltree with schema extensions;

-- 2. private schema for internal RLS helpers --------------------------------

create schema if not exists private;

comment on schema private is
  'Internal helper functions for RLS. Not exposed through PostgREST.';

-- 2b. profiles: the domain user identity (usr_) and the SINGLE seam to the
-- external SoR. Only profiles.user_id references auth.users; every other user
-- reference in the domain points at profiles(id). Created here (before
-- scope_members and every other domain table) so those tables can FK it.

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  id text unique not null default public.entity_id_generate('usr')
    check (public.is_entity_id_with_prefix(id, 'usr')),
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'Domain user identity: usr_ entity id (id) mirrored 1:1 to auth.users.id '
  '(user_id). The single seam to auth.users; the rest of the domain references '
  'profiles(id).';

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;

alter table public.profiles enable row level security;

-- No PII today, so the id<->user_id mapping is readable by any authenticated
-- user (RLS predicates resolve owners/members to their usr_ this way). Tighten
-- if profile attributes (email/display_name) are added later.
create policy "profiles are readable by authenticated users"
  on public.profiles for select to authenticated using (true);

-- Resolves the current caller's usr_ id from their auth uuid. This is the
-- translation used by every RLS predicate that must compare a usr_ column to
-- the authenticated user. security definer (reads profiles regardless of the
-- caller''s grants); in `private` so PostgREST never exposes it; stable so the
-- planner hoists it to a single evaluation per query.
create or replace function private.current_user_entity_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.profiles where user_id = (select auth.uid());
$$;

comment on function private.current_user_entity_id() is
  'usr_ entity id (profiles.id) of the currently authenticated user.';

revoke all on function private.current_user_entity_id() from public, anon;
grant execute on function private.current_user_entity_id() to authenticated;

-- Auto-provision a profile for each new auth user. In `private` (never a
-- REST-callable RPC) and definer (the caller has no rights on profiles); the
-- trigger runs it regardless of role grants.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Backfill existing users (no-op on a fresh database).
insert into public.profiles (user_id)
  select id from auth.users on conflict do nothing;

-- 3. scope_members ----------------------------------------------------------

create table public.scope_members (
  scope extensions.ltree not null,
  -- usr_ member/grantor: the domain references profiles(id), not auth.users.
  -- RLS/scope still key on auth.uid(), resolved to usr_ via
  -- private.current_user_entity_id().
  user_id text not null references public.profiles (id) on delete cascade
    check (public.is_entity_id_with_prefix(user_id, 'usr')),
  role text not null check (role in ('reader', 'writer', 'admin')),
  granted_by text references public.profiles (id)
    check (granted_by is null or public.is_entity_id_with_prefix(granted_by, 'usr')),
  created_at timestamptz not null default now(),
  primary key (scope, user_id)
);

comment on table public.scope_members is
  'Grants a user a role (reader/writer/admin) on a scope subtree. A scope is '
  'an ltree path such as `proj.acme`. Membership on a scope also allows '
  'writing to its descendants (checked by private.can_write). Personal '
  'scopes `user.<uid>` are implicit and never stored here.';

-- Gist index supports ltree ancestor/descendant operators in helper checks.
create index scope_members_scope_gist_idx
  on public.scope_members
  using gist (scope);

-- Btree index for the frequent `user_id = auth.uid()` membership lookups.
create index scope_members_user_id_idx
  on public.scope_members
  using btree (user_id);

-- Covering index for the granted_by foreign key (advisor lint 0001).
create index scope_members_granted_by_idx
  on public.scope_members
  using btree (granted_by);

-- 4. helper functions --------------------------------------------------------

-- Personal scope of the current user: `user.<usr_>` with the entity-id dot
-- folded to an underscore (ltree labels only allow [a-z0-9_]). The usr_ comes
-- from private.current_user_entity_id() (itself security definer), so this
-- function stays invoker; search_path is pinned per the db-functions rule.
create or replace function private.personal_scope()
returns extensions.ltree
language sql
stable
security invoker
set search_path = ''
as $$
  select ('user.' || replace((select private.current_user_entity_id()), '.', '_'))::extensions.ltree;
$$;

comment on function private.personal_scope() is
  'ltree personal scope `user.<uid>` for the currently authenticated user.';

-- Scopes whose shared memories the current user may read:
--   - the implicit personal scope `user.<uid>` (always present),
--   - every scope the user is a member of,
--   - all ancestors of member scopes (a member of `proj.acme.backend` can
--     read memories shared at `proj` and `proj.acme`).
-- security definer: RLS policies on `memories` call this; it must read
-- `scope_members` without triggering that table''s own RLS (and without
-- requiring broad grants for the `authenticated` role).
create or replace function private.visible_scopes()
returns extensions.ltree[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct visible.scope), '{}')
  from (
    -- implicit personal scope
    select private.personal_scope() as scope
    union
    -- member scopes and each of their ancestors (subpath 0..n)
    select extensions.subpath(scope_members.scope, 0, levels.level) as scope
    from
      public.scope_members
      cross join lateral generate_series(
        1,
        extensions.nlevel(scope_members.scope)
      ) as levels (level)
    where scope_members.user_id = (select private.current_user_entity_id())
  ) as visible;
$$;

comment on function private.visible_scopes() is
  'Array of scopes readable by the current user: personal scope, member '
  'scopes, and ancestors of member scopes. Used by RLS on public.memories.';

-- Whether the current user may write shared memories into `target_scope`:
--   - always into the personal scope,
--   - into any scope at-or-below a scope where the user is writer or admin.
-- security definer for the same reason as visible_scopes().
create or replace function private.can_write(target_scope extensions.ltree)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    target_scope operator(extensions.=) private.personal_scope()
    or exists (
      select 1
      from public.scope_members
      where
        scope_members.user_id = (select private.current_user_entity_id())
        and scope_members.role in ('writer', 'admin')
        and target_scope operator(extensions.<@) scope_members.scope
    );
$$;

comment on function private.can_write(extensions.ltree) is
  'True when the current user may write shared memories into target_scope '
  '(personal scope, or writer/admin membership on the scope or an ancestor).';

-- Whether the current user administers `target_scope` (admin on the scope or
-- an ancestor). security definer so scope_members policies can call it
-- without infinite RLS recursion on scope_members itself.
create or replace function private.is_scope_admin(target_scope extensions.ltree)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.scope_members
    where
      scope_members.user_id = (select private.current_user_entity_id())
      and scope_members.role = 'admin'
      and target_scope operator(extensions.<@) scope_members.scope
  );
$$;

comment on function private.is_scope_admin(extensions.ltree) is
  'True when the current user has the admin role on target_scope or one of '
  'its ancestors.';

-- Definer helpers must not be callable by anonymous users; authenticated
-- needs execute because RLS predicates run as the invoking role.
revoke all on function private.personal_scope() from public, anon;
revoke all on function private.visible_scopes() from public, anon;
revoke all on function private.can_write(extensions.ltree) from public, anon;
revoke all on function private.is_scope_admin(extensions.ltree) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.personal_scope() to authenticated;
grant execute on function private.visible_scopes() to authenticated;
grant execute on function private.can_write(extensions.ltree) to authenticated;
grant execute on function private.is_scope_admin(extensions.ltree) to authenticated;

-- 5. grants -------------------------------------------------------------------

-- Recent Supabase defaults no longer grant DML on new tables to the API
-- roles; grants are explicit. RLS below is the row-level fence; anon gets
-- nothing at all (fail-closed).
revoke all on public.scope_members from anon, authenticated;
grant select, insert, update, delete on public.scope_members to authenticated;
grant select, insert, update, delete on public.scope_members to service_role;

-- 6. RLS on scope_members ----------------------------------------------------

alter table public.scope_members enable row level security;

-- Fail-closed baseline: anon sees nothing (no anon policies at all).

-- Users can see their own membership rows; scope admins additionally see
-- every membership row inside their subtree. One combined permissive policy
-- (a single OR) instead of two: the advisor flags multiple permissive
-- policies per role/action as a performance smell.
create policy "members view own rows and admins view their subtree"
on public.scope_members
for select
to authenticated
using (
  user_id = (select private.current_user_entity_id())
  or private.is_scope_admin(scope)
);

-- Minimal M1 management surface: only scope admins grant memberships.
-- The very first admin of a scope is provisioned out-of-band (service role).
create policy "scope admins can grant memberships in their subtree"
on public.scope_members
for insert
to authenticated
with check ( private.is_scope_admin(scope) );

-- Scope admins can change roles inside their subtree.
create policy "scope admins can update memberships in their subtree"
on public.scope_members
for update
to authenticated
using ( private.is_scope_admin(scope) )
with check ( private.is_scope_admin(scope) );

-- Scope admins can revoke memberships inside their subtree.
create policy "scope admins can revoke memberships in their subtree"
on public.scope_members
for delete
to authenticated
using ( private.is_scope_admin(scope) );
