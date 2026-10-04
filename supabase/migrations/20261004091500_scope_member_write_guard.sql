-- Migration: a membership row changes only in the ways its people agreed to
--
-- Purpose:
--   public.scope_members carries two permissive UPDATE policies: an admin
--   updates the memberships of their subtree, and an invitee updates their own
--   pending row to accept it. Postgres combines permissive policies with OR,
--   separately for USING and for WITH CHECK, and a WITH CHECK cannot see the
--   old row. The acceptance policy checks only `user_id`, so a row that one
--   policy admits could be rewritten into a shape only the other one checks:
--   a member could turn a membership they hold into an accepted admin
--   membership of a scope nobody gave them. `authenticated` held a table-wide
--   update grant, and nothing guarded the columns.
--
--   The same gap let an admin record another person's membership as already
--   accepted, which is the consent the membership model rests on, and let an
--   invitee pick a different role while accepting.
--
--   1. No one moves a membership through the API: `authenticated` keeps an
--      update grant only on `role`, `granted_by`, `accepted_at` and
--      `invited_email`. `scope`, `user_id` and `created_at` are fixed.
--   2. A guard binds a signed-in caller:
--      - only an admin of the scope changes a member's role, and a change of
--        granter names that admin;
--      - `accepted_at` is set once, from empty, by the invited person, and is
--        stamped with the current time;
--      - the invited address is changed by an admin, or cleared by the invitee
--        when accepting;
--      - a membership an admin adds for someone else starts unaccepted and is
--        granted by that admin; every new row is stamped with the current time.
--
-- Affected objects:
--   - table public.scope_members: update grant for authenticated narrowed to
--     columns
--   - function private.guard_scope_member_write (new, trigger)
--   - trigger scope_members_guard_write on public.scope_members (new)
--
-- Special considerations:
--   - The guard acts only when the statement runs as `authenticated`: a
--     PostgREST request, or a SECURITY INVOKER function it calls
--     (add_scope_member, invite_scope_member, accept_scope_invitation). The
--     service role and the SECURITY DEFINER functions (create_scope,
--     rename_scope, merge_scopes, delete_scope, decline_scope_invitation,
--     account erasure) run as other roles and authorize their own writes, so
--     they are untouched. The function is SECURITY INVOKER for exactly that
--     reason: `current_user` must be the role that ran the statement.
--   - Insert triggers fire in name order: scope_members_accept_self_grant
--     (accepts a row the caller adds for themselves) runs before
--     scope_members_guard_write, which only touches rows for someone else.

-- 1. fixed columns ----------------------------------------------------------------

-- Revoking the table-level privilege is required: a table grant would make any
-- column restriction moot.
revoke update on public.scope_members from authenticated;
grant update (role, granted_by, accepted_at, invited_email)
  on public.scope_members to authenticated;

-- 2. the guard ----------------------------------------------------------------------

create or replace function private.guard_scope_member_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_me text;
  v_admin boolean;
begin
  -- Only a signed-in caller is bound here; every other role that writes
  -- memberships authorizes its own writes.
  if current_user <> 'authenticated' then
    return new;
  end if;
  v_me := (select private.current_user_entity_id());
  if v_me is null then
    raise exception 'Changing a membership needs a signed-in caller.'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    new.created_at := now();
    new.granted_by := v_me;
    -- A membership for someone else waits for that person to accept it.
    if new.user_id is distinct from v_me then
      new.accepted_at := null;
    end if;
    return new;
  end if;

  -- The column grant already keeps these out of reach; checked here too, so a
  -- grant widened later cannot reopen the hole.
  if new.scope::text is distinct from old.scope::text
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at
  then
    raise exception 'A membership''s scope, member and creation time never change.'
      using errcode = '42501';
  end if;

  v_admin := private.is_scope_admin(old.scope);

  if new.role is distinct from old.role and not v_admin then
    raise exception 'Only an admin of scope % changes a member''s role.', old.scope
      using errcode = '42501';
  end if;

  if new.granted_by is distinct from old.granted_by
     and not (v_admin and new.granted_by = v_me)
  then
    raise exception 'A membership is granted only in the name of the admin granting it.'
      using errcode = '42501';
  end if;

  if new.accepted_at is distinct from old.accepted_at then
    if old.accepted_at is not null
       or new.accepted_at is null
       or old.user_id <> v_me
    then
      raise exception 'Only the invited person accepts a membership, and only once.'
        using errcode = '42501';
    end if;
    new.accepted_at := now();
  end if;

  if new.invited_email is distinct from old.invited_email
     and not v_admin
     and not (old.user_id = v_me and new.invited_email is null)
  then
    raise exception 'Only an admin of scope % changes the invited address.', old.scope
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function private.guard_scope_member_write() is
  'Binds a signed-in caller''s write of a membership: scope, member and '
  'creation time never change; only an admin of the scope changes the role, '
  'in their own name; only the invited person accepts, once; a membership '
  'added for someone else starts unaccepted. The service role and SECURITY '
  'DEFINER functions are not bound.';

-- A trigger function needs no execute grant to fire; nothing calls it directly.
revoke all on function private.guard_scope_member_write()
  from public, anon, authenticated;

create trigger scope_members_guard_write
  before insert or update on public.scope_members
  for each row execute function private.guard_scope_member_write();

comment on policy "members accept their own pending invitations"
  on public.scope_members is
  'Lets the invitee reach their own pending row. What they may change in it '
  '(accepted_at, once, and clearing the invited address) is enforced by '
  'private.guard_scope_member_write, because a WITH CHECK cannot compare the '
  'new row with the old one.';
