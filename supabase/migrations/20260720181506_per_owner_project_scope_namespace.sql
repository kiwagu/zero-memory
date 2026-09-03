-- Migration: per-owner project-scope namespace (`proj.<owner>.<slug>`)
--
-- Purpose:
--   Project scopes were a bare global ltree path `proj.<slug>`. In a pooled
--   database (one Postgres shared by unrelated users) the first claimant
--   of a slug becomes its admin, and a second user whose project derives
--   the same slug (e.g. both have a repo named `api`) is REJECTED by
--   create_scope's "scope already has members" guard, so their auto-captured
--   memories silently fall back to the personal scope. That is a broken
--   onboarding, not a leak (can_write/visible_scopes hold), but it must be
--   fixed before the database is shared across unrelated users.
--
--   The fix namespaces project scopes per OWNER: `proj.<owner_entity_id>.<slug>`.
--   Two users' same-named projects become sibling scopes that differ at
--   the second label, so neither collides. A slug match therefore never
--   grants shared access — collaboration on one project stays an explicit
--   membership act (add_scope_member), never an automatic consequence of a
--   matching name. Project scopes remain inside the shareable `proj.*` tree
--   (not the private personal subtree), so team sharing is still
--   possible.
--
-- Affected objects:
--   - function public.create_scope(extensions.ltree)   (CREATE OR REPLACE)
--   - constraint public.project_bindings unique(match_kind, match_key)
--       -> unique(created_by, match_kind, match_key)   (per-owner bindings)
--   - data re-path of existing `proj.*` rows across public.memories,
--     public.entities, public.edges, public.scope_members,
--     public.project_bindings
--
-- Scope of the change:
--   - Only `proj.*` is namespaced. `team.*` scopes stay global: a team scope
--     is created deliberately by a human, so a name clash there is a conscious
--     conflict, not a broken auto-routing onboarding. (Team-sharing follow-up,
--     not in this migration: after an invitee joins a shared project scope,
--     their auto-ingest still routes to their own `proj.<them>.<slug>`; to
--     land it in the shared scope the invite must also create a per-owner
--     binding (invitee, identity) -> shared scope.)
--
-- Special considerations:
--   - This is a FORWARD data migration (not a reset-mode rewrite of history):
--     the live corpus is the owner's real memory and cannot be reset. It is
--     rehearsed on an e2e clone of live before any promote.
--   - The owner of each existing project scope is derived from its `admin`
--     row in scope_members (verified 1 admin per proj scope on live).
--   - create_scope keeps `security definer` + `set search_path = ''`; every
--     reference stays schema-qualified.

set search_path = public, extensions;

-- 1. Re-path existing `proj.*` data to the per-owner namespace ----------------

-- Owner map: for each existing top-level project root `proj.<slug>` that has
-- an admin membership, capture the owner label (its entity id folded to a
-- single ltree label the same way personal_scope() folds it: `.` -> `_`).
-- Re-pathing then INSERTS this label right after `proj`, turning
-- `proj.<slug>[.<rest>]` into `proj.<owner>.<slug>[.<rest>]` at any depth.
-- Materialized BEFORE any update so re-pathing scope_members cannot disturb
-- the derivation.
create temp table _proj_reroot on commit drop as
select distinct
  extensions.subltree(sm.scope, 0, 2) as old_root,
  replace(sm.user_id, '.', '_')::extensions.ltree as owner_label
from public.scope_members sm
where
  sm.role = 'admin'
  and extensions.subltree(sm.scope, 0, 1)::text = 'proj';

-- Guard: every project root that carries data must have an owner mapping,
-- otherwise its rows would be left on the old global path. Fail loudly.
do $$
declare
  v_orphan text;
begin
  select string_agg(distinct extensions.subltree(scope, 0, 2)::text, ', ')
  into v_orphan
  from (
    select scope from public.memories where scope operator(extensions.<@) 'proj'::extensions.ltree
    union all
    select scope from public.entities where scope operator(extensions.<@) 'proj'::extensions.ltree
    union all
    select scope from public.edges where scope operator(extensions.<@) 'proj'::extensions.ltree
    union all
    select scope from public.scope_members where scope operator(extensions.<@) 'proj'::extensions.ltree
  ) rows
  where not exists (
    select 1 from _proj_reroot r
    where rows.scope operator(extensions.<@) r.old_root
  );
  if v_orphan is not null then
    raise exception
      'project roots without an admin owner cannot be re-pathed: %', v_orphan;
  end if;
end;
$$;

-- Re-path every table by INSERTING the owner label after `proj`:
--   proj.<slug>[.<rest>]  ->  proj.<owner>.<slug>[.<rest>]
-- Built as subpath(scope,0,1) || owner || subpath(scope,1): the leading
-- `proj` label, the owner label, then everything from the slug onward. This
-- avoids the boundary case of subpath at offset = nlevel (invalid) and works
-- at any depth. The mapping is injective (distinct old_root -> distinct new
-- root, suffix kept), so it can never collide two rows onto one scope (safe
-- for the unique(normalized_name, type, scope) indexes on entities/edges).

update public.memories m
set scope = extensions.subpath(m.scope, 0, 1)
  operator(extensions.||) r.owner_label
  operator(extensions.||) extensions.subpath(m.scope, 1)
from _proj_reroot r
where m.scope operator(extensions.<@) r.old_root;

update public.entities e
set scope = extensions.subpath(e.scope, 0, 1)
  operator(extensions.||) r.owner_label
  operator(extensions.||) extensions.subpath(e.scope, 1)
from _proj_reroot r
where e.scope operator(extensions.<@) r.old_root;

update public.edges g
set scope = extensions.subpath(g.scope, 0, 1)
  operator(extensions.||) r.owner_label
  operator(extensions.||) extensions.subpath(g.scope, 1)
from _proj_reroot r
where g.scope operator(extensions.<@) r.old_root;

update public.scope_members s
set scope = extensions.subpath(s.scope, 0, 1)
  operator(extensions.||) r.owner_label
  operator(extensions.||) extensions.subpath(s.scope, 1)
from _proj_reroot r
where s.scope operator(extensions.<@) r.old_root;

update public.project_bindings b
set scope = extensions.subpath(b.scope, 0, 1)
  operator(extensions.||) r.owner_label
  operator(extensions.||) extensions.subpath(b.scope, 1)
from _proj_reroot r
where b.scope operator(extensions.<@) r.old_root;

-- 2. project_bindings: global identity -> per-owner identity ------------------

-- The old unique made a project identity claimable by ONE user across the
-- whole database; a second user with the same normalized path/remote
-- could not record their own binding. Per-owner uniqueness lets each user
-- bind their own identities independently (routing stays deterministic per
-- user; a binding still grants nothing on its own).
alter table public.project_bindings
  drop constraint project_bindings_match_kind_match_key_key;

alter table public.project_bindings
  add constraint project_bindings_created_by_match_kind_match_key_key
  unique (created_by, match_kind, match_key);

-- 3. create_scope: enforce the per-owner project root ------------------------

-- Adds one rule to the existing bootstrap: under the `project`/`proj` root a
-- caller may only create a scope inside their OWN `proj.<caller_id>` subtree.
-- This is what makes the namespace safe as well as collision-free: without it
-- a caller could create the bare ancestor `proj.<victim_id>` and become admin
-- of an ancestor of the victim's project scopes, and can_write cascades DOWN
-- (target <@ member.scope) -> a write leak. Modeled on personal_subtree_scopes
-- (another user's root differs at the second label). `team.*` is unchanged.
create or replace function public.create_scope(p_scope extensions.ltree)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  scope_root text;
  v_owner_label text;
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

  -- Project scopes are namespaced per owner: `proj.<caller_id>.<name>`. A
  -- caller may only create inside their own owner root, so no one can squat
  -- another user's namespace or claim an ancestor of it.
  if scope_root in ('project', 'proj') then
    if extensions.nlevel(p_scope) < 3 then
      raise exception
        'invalid project scope "%": expected proj.<owner>.<name>', p_scope;
    end if;
    v_owner_label := replace(
      (select private.current_user_entity_id()), '.', '_'
    );
    if extensions.subltree(p_scope, 1, 2)::text <> v_owner_label then
      raise exception
        'invalid project scope "%": second label must be the caller''s own id',
        p_scope;
    end if;
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
  'Creates a shared scope by inserting the caller as its first admin. '
  'Project scopes are namespaced per owner (proj.<caller_id>.<name>): a '
  'caller may only create inside their own owner root. team.* is global. '
  'Raises when the scope or a related scope already has members. security '
  'definer: bootstraps past the admin-only RLS insert policy on scope_members.';

-- Grants are unchanged by CREATE OR REPLACE; re-assert them for clarity.
revoke all on function public.create_scope(extensions.ltree) from public, anon;
grant execute on function public.create_scope(extensions.ltree)
  to authenticated, service_role;
