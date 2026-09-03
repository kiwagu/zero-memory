-- Migration: scope management RPCs and share integrity
--
-- Purpose:
--   M3 team sharing. Adds the RPCs that let an authenticated user bootstrap
--   a team/project scope (becoming its first admin), grant memberships, and
--   probe write access before sharing a memory into a scope. Also hardens
--   the memories table so shared rows always carry their share provenance.
--
-- Affected objects:
--   - function: public.create_scope(extensions.ltree)          (security definer)
--   - function: public.add_scope_member(extensions.ltree, text, text)
--   - function: public.can_write_scope(extensions.ltree)
--   - constraint: public.memories memories_shared_lifecycle_check
--
-- Special considerations:
--   - create_scope is `security definer` ON PURPOSE: it inserts the very
--     first admin row of a scope, which the invoker-level RLS insert policy
--     on scope_members ("scope admins can grant memberships") would reject
--     because no admin exists yet. It pins search_path = '' and validates
--     everything explicitly (authenticated caller, allowed scope roots, no
--     already-claimed scope in either direction of the subtree).
--   - add_scope_member and can_write_scope stay `security invoker`: RLS on
--     scope_members / execute grants on private.can_write are the fence.
--   - Both RPCs are deliberately REST-callable by authenticated users
--     (accepted advisor residue, see create-migration rule); anon gets
--     nothing.

-- Migration DDL below parses ltree operators/types; keep the extensions
-- schema resolvable while the file runs (functions still pin their own
-- search_path). Session-level `set`: the CLI applies statements outside an
-- explicit transaction block.
set search_path = public, extensions;

-- 1. create_scope -------------------------------------------------------------

-- Bootstrap a shared scope: validates the path, then inserts the caller as
-- the scope's first admin. Fails when the scope — or any ancestor/descendant
-- scope — already has members: becoming admin of a relative of an existing
-- scope would leak read (ancestors are readable via visible_scopes) or write
-- (descendants are writable via can_write) access. v1 only allows creating
-- `project.*` / `team.*` scopes (plus the `proj.*` shorthand used by the
-- domain layer); `global` and everything else stay service-role territory.
create or replace function public.create_scope(p_scope extensions.ltree)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  scope_root text;
begin
  if (select auth.uid()) is null then
    raise exception 'create_scope requires an authenticated user';
  end if;

  if extensions.nlevel(p_scope) < 2 then
    raise exception
      'invalid scope "%": expected at least <root>.<name>', p_scope;
  end if;

  scope_root := extensions.subltree(p_scope, 0, 1)::text;
  if scope_root not in ('project', 'proj', 'team') then
    raise exception
      'invalid scope "%": only project.* / proj.* / team.* scopes can be created',
      p_scope;
  end if;

  -- Serialize concurrent creations inside the same scope tree so two racing
  -- callers cannot both pass the emptiness check for related scopes.
  perform pg_advisory_xact_lock(hashtext('zero-memory:create_scope:' || scope_root));

  if exists (
    select 1
    from public.scope_members
    where
      scope_members.scope operator(extensions.@>) p_scope
      or scope_members.scope operator(extensions.<@) p_scope
  ) then
    raise exception
      'scope "%" (or an ancestor/descendant scope) already has members', p_scope;
  end if;

  insert into public.scope_members (scope, user_id, role, granted_by)
  values (
    p_scope,
    (select private.current_user_entity_id()),
    'admin',
    (select private.current_user_entity_id())
  );
end;
$$;

comment on function public.create_scope(extensions.ltree) is
  'Creates a shared scope (project.*/proj.*/team.*) by inserting the caller '
  'as its first admin. Raises when the scope or a related scope already has '
  'members. security definer: bootstraps past the admin-only RLS insert '
  'policy on scope_members.';

-- Definer function: never callable anonymously.
revoke all on function public.create_scope(extensions.ltree) from public, anon;
grant execute on function public.create_scope(extensions.ltree)
  to authenticated, service_role;

-- 2. add_scope_member ---------------------------------------------------------

-- Grants (or re-grades) a membership. security invoker: the RLS policies on
-- scope_members already restrict insert/update to scope admins, so this is
-- just a convenient idempotent upsert with role validation.
create or replace function public.add_scope_member(
  p_scope extensions.ltree,
  p_user text,
  p_role text
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_role not in ('reader', 'writer', 'admin') then
    raise exception
      'invalid role "%": expected reader | writer | admin', p_role;
  end if;

  insert into public.scope_members (scope, user_id, role, granted_by)
  values (p_scope, p_user, p_role, (select private.current_user_entity_id()))
  on conflict (scope, user_id)
  do update set
    role = excluded.role,
    granted_by = excluded.granted_by;
end;
$$;

comment on function public.add_scope_member(extensions.ltree, text, text) is
  'Idempotently grants p_user the p_role membership on p_scope. security '
  'invoker: the admin-only RLS policies on scope_members are the fence.';

revoke all on function public.add_scope_member(extensions.ltree, text, text)
  from public, anon;
grant execute on function public.add_scope_member(extensions.ltree, text, text)
  to authenticated, service_role;

-- 3. can_write_scope ----------------------------------------------------------

-- REST-callable probe used by the application before sharing a memory into a
-- scope (fail-closed app-side check on top of RLS). Thin invoker wrapper: the
-- private helper is not exposed through PostgREST.
create or replace function public.can_write_scope(p_scope extensions.ltree)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.can_write(p_scope);
$$;

comment on function public.can_write_scope(extensions.ltree) is
  'True when the current user may write shared memories into p_scope. '
  'Invoker wrapper around private.can_write for application-side checks.';

revoke all on function public.can_write_scope(extensions.ltree)
  from public, anon;
grant execute on function public.can_write_scope(extensions.ltree)
  to authenticated, service_role;

-- 4. share integrity on memories ---------------------------------------------

-- A shared memory must always record when and by whom it was shared: the
-- application sets shared_at/shared_by, this constraint makes forgetting
-- them impossible. Existing rows are validated at creation time (there are
-- no shared rows without provenance in any deployed dataset).
alter table public.memories
add constraint memories_shared_lifecycle_check
check (
  visibility <> 'shared'
  or (shared_at is not null and shared_by is not null)
);
