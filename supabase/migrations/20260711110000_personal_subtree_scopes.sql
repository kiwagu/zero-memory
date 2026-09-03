-- Migration: personal-subtree scopes (user.<uid>.core) in RLS helpers
--
-- Purpose:
--   The personal core scope (`user.<uid>.core`, home of portable knowledge)
--   is a CHILD of the personal scope. Memories already work there (private
--   rows may target any scope and are owner-read), but the graph around them
--   does not: private.can_write matched the personal scope EXACTLY, so
--   entity/edge inserts into the core scope were denied, and the
--   visible_scopes-based select policies on entities/edges never listed
--   personal descendants. This widens the personal check from equality to
--   the personal SUBTREE — which by construction belongs to the caller only
--   (another user's personal_scope() differs at its second label).
--
-- Affected objects:
--   - function private.can_write(extensions.ltree)      (CREATE OR REPLACE)
--   - policy "members read entities in visible scopes"  on public.entities
--   - policy "members read edges in visible scopes"     on public.edges
--
-- Special considerations:
--   - Idempotent (CREATE OR REPLACE / ALTER POLICY): safe on the live stack.
--   - No grant changes; signatures unchanged.

set search_path = public, extensions;

-- 1. can_write: personal equality -> personal subtree -------------------------

create or replace function private.can_write(target_scope extensions.ltree)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    target_scope operator(extensions.<@) private.personal_scope()
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
  '(personal scope subtree, or writer/admin membership on the scope or an '
  'ancestor).';

-- 2. entities/edges read: personal subtree is always visible to its owner -----

alter policy "members read entities in visible scopes"
on public.entities
using (
  scope = any (((select private.visible_scopes()))::extensions.ltree[])
  or scope operator(extensions.<@) private.personal_scope()
);

alter policy "members read edges in visible scopes"
on public.edges
using (
  scope = any (((select private.visible_scopes()))::extensions.ltree[])
  or scope operator(extensions.<@) private.personal_scope()
);
