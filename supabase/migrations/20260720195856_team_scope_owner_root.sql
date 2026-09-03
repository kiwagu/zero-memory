-- Migration: owner-rooted team scopes (`team.<creator>.<slug>`) + stranded-row repair
--
-- Purpose:
--   Completes the per-owner scope namespace started by
--   20260720181506_per_owner_project_scope_namespace: the `team` root kept
--   the old global form (`team.<slug>`), so in a database shared by several
--   users the first claimant of a team name still became its admin and a
--   second user's same-named team was rejected. Deliberate team creation
--   made that a conscious conflict rather than broken onboarding, but the
--   squatting surface is the same — and closing it now is free while no
--   `team.*` scope exists yet (verified: zero rows under `team` in
--   memories/entities/edges/scope_members/project_bindings). Team scopes
--   therefore become `team.<creator_id>.<slug>`. The creator label is an
--   opaque namespace token, exactly as in project scopes: real ownership
--   and admin rights live in scope_members and remain transferable, and a
--   name coincidence never grants shared access — collaboration stays an
--   explicit membership act.
--
--   Also repairs 11 memories stranded in the bare one-label `project`
--   scope (a caller once passed the literal scope "project"): that path is
--   outside every default read set, so the rows were invisible to recall.
--   Content inspection shows all of them are facts about this repository's
--   own project, so they are re-pathed into their owner's per-owner scope
--   for it.
--
-- Affected objects:
--   - function public.create_scope(extensions.ltree)   (CREATE OR REPLACE)
--   - data repair: public.memories rows with scope = 'project'
--
-- Special considerations:
--   - No team.* re-path: the subtree is empty everywhere (verified on the
--     live database before authoring).
--   - create_scope keeps `security definer` + `set search_path = ''`.

set search_path = public, extensions;

-- 1. create_scope: per-owner root for team scopes too -------------------------

-- Same rule as for project scopes: under a shareable root the caller may
-- only create inside their OWN `<root>.<caller_id>` subtree. Without this,
-- per-owner roots leak: a caller could create the bare ancestor
-- `team.<victim_id>` and become admin of an ancestor of the victim's team
-- scopes (can_write cascades down the subtree).
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

  -- Shareable scopes are namespaced per creator: `<root>.<caller_id>.<name>`.
  -- A caller may only create inside their own owner root, so no one can
  -- squat another user's namespace or claim an ancestor of it.
  if extensions.nlevel(p_scope) < 3 then
    raise exception
      'invalid scope "%": expected %.<owner>.<name>', p_scope, scope_root;
  end if;
  v_owner_label := replace(
    (select private.current_user_entity_id()), '.', '_'
  );
  if extensions.subltree(p_scope, 1, 2)::text <> v_owner_label then
    raise exception
      'invalid scope "%": second label must be the caller''s own id',
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
  'Creates a shared scope by inserting the caller as its first admin. All '
  'shareable roots (project.*/proj.*/team.*) are namespaced per creator '
  '(<root>.<caller_id>.<name>): a caller may only create inside their own '
  'owner root. Raises when the scope or a related scope already has '
  'members. security definer: bootstraps past the admin-only RLS insert '
  'policy on scope_members.';

-- Grants are unchanged by CREATE OR REPLACE; re-assert them for clarity.
revoke all on function public.create_scope(extensions.ltree) from public, anon;
grant execute on function public.create_scope(extensions.ltree)
  to authenticated, service_role;

-- 2. Repair memories stranded in the bare `project` scope ---------------------

-- A one-label `project` scope is not a valid home (no default read set ever
-- includes it, so its rows are unreachable by recall). The stranded rows —
-- all facts about this repository's own project (inspected individually
-- before authoring) — move into their owner's per-owner project scope for
-- it. Owner-derived, idempotent, and a no-op on databases without such
-- rows (e.g. a fresh reset).
update public.memories m
set scope = (
  'proj.' || replace(m.owner_id, '.', '_') || '.zero_memory'
)::extensions.ltree
where m.scope = 'project'::extensions.ltree;
