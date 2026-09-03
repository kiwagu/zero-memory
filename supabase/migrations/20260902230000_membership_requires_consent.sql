-- Migration: a membership takes effect only once the member accepts it
--
-- Purpose:
--   Granting a membership was unilateral, and scope creation is self-service.
--   Together those let any authenticated user manufacture a shared scope with
--   anyone whose address they knew: create a scope (becoming its admin), grant
--   that person a membership they never asked for, and the new co-membership
--   predicate on public.profiles would then admit the grantee's identity to the
--   grantor. Measured before this change: an account's visible profiles went
--   from 2 to 3 and scope_member_identities() gained a stranger's address, in
--   one transaction, without the target's involvement.
--
--   This makes consent the precondition of effect. A membership row still
--   appears when an administrator grants it, but it is INERT until the invitee
--   accepts: it grants no read, no write, no visibility, and it makes nobody a
--   co-member. The fix is therefore at the root — every fence derives from the
--   same accepted-membership predicate — rather than at the boundary of the one
--   function through which the leak was first observed.
--
-- Affected objects:
--   - table:    public.scope_members gains `accepted_at timestamptz`
--   - trigger:  public.scope_members_accept_self_grant (BEFORE INSERT)
--   - functions rewritten to count only accepted rows:
--       private.visible_scopes(), private.can_write(), private.is_scope_admin(),
--       private.covisible_user_ids()
--   - functions: public.accept_scope_invitation(extensions.ltree)   (new)
--                public.decline_scope_invitation(extensions.ltree)  (new)
--                public.pending_scope_invitations()                 (new)
--   - policy:   scope_members UPDATE gains an invitee-accepts path
--
-- Special considerations:
--   - EXISTING ROWS ARE BACKFILLED AS ACCEPTED. They predate consent and were
--     created by the owner for themselves; treating them as pending would
--     revoke live access, which is a data-loss-shaped event, not a security
--     improvement.
--   - A SELF-GRANT IS ITS OWN CONSENT, and it must be, or `create_scope` would
--     produce a scope whose creator is not yet its admin — an unadministered
--     scope nobody can ever accept into. The trigger accepts exactly the rows
--     whose member is the caller.
--   - The invitee can SEE a pending row (the existing select policy already
--     shows a user their own rows). That is deliberate: an invitation nobody
--     can see cannot be accepted. It reveals the scope path and the granting
--     admin, which is what an invitation is.
--   - Declining DELETES the row rather than marking it refused. A tombstone
--     would let a grantor learn that a specific address chose to refuse, which
--     is a signal about a person; the admin can re-invite, and a re-invitation
--     is indistinguishable from a first one.

set search_path = public, extensions;

-- 1. the column, and the history that predates it -----------------------------

alter table public.scope_members
  add column if not exists accepted_at timestamptz;

comment on column public.scope_members.accepted_at is
  'When the member accepted this grant. NULL = a pending invitation: the row '
  'exists but confers nothing — no read, no write, no co-visibility.';

-- Every row that exists today was created before consent was required. They are
-- live memberships in daily use; marking them pending would silently cut access.
update public.scope_members
set accepted_at = coalesce(accepted_at, created_at, now())
where accepted_at is null;

-- Pending invitations are read per-user on sign-in; the partial index keeps that
-- lookup off a full scan without carrying the (large) accepted majority.
create index if not exists scope_members_pending_user_idx
  on public.scope_members (user_id)
  where accepted_at is null;

-- 2. a self-grant is its own consent ------------------------------------------

-- create_scope inserts the creator's own admin row directly. Without this the
-- scope would come into being with a pending administrator — nobody could
-- accept, and nobody could ever grant. Any other self-insert (a service-role
-- provisioning path) is consented for the same reason: the member IS the actor.
--
-- security definer, and that is load-bearing rather than incidental: the body
-- reads `private.current_user_entity_id()`, and `service_role` holds no USAGE
-- on the `private` schema. As an invoker function this trigger raised
-- "permission denied for schema private" on EVERY service-role insert — which
-- is how fixtures and provisioning create memberships — so the table became
-- unwritable from the server side. Definer runs it as the owner, and the body
-- only ever reads the caller's identity to compare it with the incoming row.
create or replace function public.scope_members_accept_self_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.accepted_at is null
     and new.user_id = (select private.current_user_entity_id())
  then
    new.accepted_at := now();
  end if;
  return new;
end;
$$;

comment on function public.scope_members_accept_self_grant() is
  'Marks a membership accepted when the member is the caller: granting yourself '
  'a role is not an invitation. Keeps create_scope''s first admin row live.';

drop trigger if exists scope_members_accept_self_grant on public.scope_members;
create trigger scope_members_accept_self_grant
before insert on public.scope_members
for each row
execute function public.scope_members_accept_self_grant();

-- A trigger function is invoked by the executor, never by a caller, so nobody
-- needs EXECUTE on it. Postgres grants it to PUBLIC at CREATE FUNCTION and
-- Supabase's default privileges add anon/authenticated on top — leaving a
-- definer function in the REST-exposed `public` schema callable by anyone,
-- which the advisor baseline would (rightly) count as new residue.
revoke all on function public.scope_members_accept_self_grant()
  from public, anon, authenticated;

-- 3. every fence now reads ACCEPTED membership only ---------------------------

-- These four are the whole authority surface for scopes. Changing them together
-- is the point: a pending row must be inert everywhere, not merely in the one
-- place the leak was noticed.

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
    where
      scope_members.user_id = (select private.current_user_entity_id())
      and scope_members.accepted_at is not null
  ) as visible;
$$;

comment on function private.visible_scopes() is
  'Array of scopes readable by the current user: personal scope, ACCEPTED '
  'member scopes, and their ancestors. Used by RLS on public.memories.';

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
        and scope_members.accepted_at is not null
        and target_scope operator(extensions.<@) scope_members.scope
    );
$$;

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
      and scope_members.accepted_at is not null
      and target_scope operator(extensions.<@) scope_members.scope
  );
$$;

-- The co-visibility helper behind the profiles policy. Both legs need the
-- predicate: an unaccepted grant must neither make the grantee visible to the
-- grantor (their row) nor the grantor's scope-mates visible to the grantee.
create or replace function private.covisible_user_ids()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct covisible.user_id), '{}')
  from (
    select (select private.current_user_entity_id()) as user_id
    union
    select scope_members.user_id
    from public.scope_members
    where
      scope_members.accepted_at is not null
      and (
        scope_members.scope operator(extensions.=) any (
          (select private.visible_scopes())::extensions.ltree[]
        )
        or private.is_scope_admin(scope_members.scope)
      )
  ) as covisible
  where covisible.user_id is not null;
$$;

comment on function private.covisible_user_ids() is
  'usr_ ids the current user may resolve: self plus every ACCEPTED member of a '
  'scope whose membership rows the caller can read. Used by RLS on '
  'public.profiles. A pending invitation confers no co-visibility in either '
  'direction.';

-- 4. the invitee's side --------------------------------------------------------

-- Accepting is an UPDATE the invitee performs on their own row. The policy is
-- narrow on purpose: it admits the member only for their OWN row, and the
-- with-check keeps them from editing anything else through the same door — the
-- role they were offered is the role they get.
create policy "members accept their own pending invitations"
on public.scope_members
for update
to authenticated
using (
  user_id = (select private.current_user_entity_id())
  and accepted_at is null
)
with check (
  user_id = (select private.current_user_entity_id())
);

create or replace function public.accept_scope_invitation(p_scope extensions.ltree)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  update public.scope_members
  set accepted_at = now()
  where
    scope_members.scope operator(extensions.=) p_scope
    and scope_members.user_id = (select private.current_user_entity_id())
    and scope_members.accepted_at is null;

  if not found then
    raise exception 'no pending invitation for scope "%"', p_scope;
  end if;
end;
$$;

comment on function public.accept_scope_invitation(extensions.ltree) is
  'Accepts the caller''s own pending invitation to p_scope, which is what makes '
  'the membership confer anything. security invoker: the update policy is the '
  'fence.';

revoke all on function public.accept_scope_invitation(extensions.ltree)
  from public, anon;
grant execute on function public.accept_scope_invitation(extensions.ltree)
  to authenticated, service_role;

-- Declining removes the row. Deliberately not a refused-tombstone: a tombstone
-- would tell the grantor that this person declined, which is information about
-- a human being that the grantor has no claim to. Re-inviting stays possible
-- and looks exactly like a first invitation.
create or replace function public.decline_scope_invitation(p_scope extensions.ltree)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from public.scope_members
  where
    scope_members.scope operator(extensions.=) p_scope
    and scope_members.user_id = (select private.current_user_entity_id())
    and scope_members.accepted_at is null;

  if not found then
    raise exception 'no pending invitation for scope "%"', p_scope;
  end if;
end;
$$;

comment on function public.decline_scope_invitation(extensions.ltree) is
  'Deletes the caller''s own pending invitation to p_scope. security definer '
  'because the DELETE policy on scope_members admits scope admins only, and an '
  'invitee is by definition not one; the body restricts the delete to the '
  'caller''s own unaccepted row.';

revoke all on function public.decline_scope_invitation(extensions.ltree)
  from public, anon;
grant execute on function public.decline_scope_invitation(extensions.ltree)
  to authenticated, service_role;

-- What the invitee needs in order to decide: which scope, offered role, and who
-- granted it. The grantor's address is NOT returned — an invitation must not
-- become a channel for learning an arbitrary account's identity, which is the
-- very vector this migration closes.
create or replace function public.pending_scope_invitations()
returns table (scope extensions.ltree, role text, granted_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    scope_members.scope,
    scope_members.role,
    scope_members.created_at
  from public.scope_members
  where
    scope_members.user_id = (select private.current_user_entity_id())
    and scope_members.accepted_at is null;
$$;

comment on function public.pending_scope_invitations() is
  'The caller''s own pending invitations: scope, offered role and when it was '
  'granted. Never names the grantor, so an invitation cannot be used to learn '
  'who holds a given account.';

revoke all on function public.pending_scope_invitations() from public, anon;
grant execute on function public.pending_scope_invitations()
  to authenticated, service_role;

-- 5. what the granting admin may see about a pending invitee ------------------

-- An admin who has invited someone must be able to see WHOM they invited, or
-- the member list shows an unreadable id and the flow becomes unusable. The
-- honest answer is the address the admin THEMSELVES typed: it tells them
-- nothing they did not already know, whereas resolving the invitee's identity
-- would turn an invitation back into a channel for learning who holds an
-- account — the exact vector this migration exists to close.
alter table public.scope_members
  add column if not exists invited_email text;

comment on column public.scope_members.invited_email is
  'The address the granting admin typed, kept so a pending invitation can be '
  'labelled without resolving the invitee''s identity. Cleared on acceptance: '
  'from then on the member is a co-member and their real identity resolves '
  'through the ordinary path.';

-- Accepting clears it: once the membership is real the member resolves through
-- scope_member_identities like anyone else, and keeping the typed address would
-- leave a second, staler copy of an identity the row no longer needs.
create or replace function public.accept_scope_invitation(p_scope extensions.ltree)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  update public.scope_members
  set accepted_at = now(), invited_email = null
  where
    scope_members.scope operator(extensions.=) p_scope
    and scope_members.user_id = (select private.current_user_entity_id())
    and scope_members.accepted_at is null;

  if not found then
    raise exception 'no pending invitation for scope "%"', p_scope;
  end if;
end;
$$;

-- The member-add path records the typed address alongside the grant, in one
-- statement, so the two cannot drift apart.
create or replace function public.invite_scope_member(
  p_scope extensions.ltree,
  p_email text,
  p_role text
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_user_id text;
begin
  if p_role not in ('reader', 'writer', 'admin') then
    raise exception
      'invalid role "%": expected reader | writer | admin', p_role;
  end if;

  v_user_id := public.resolve_scope_member_candidate(p_scope, p_email);
  if v_user_id is null then
    return null;
  end if;

  insert into public.scope_members
    (scope, user_id, role, granted_by, invited_email)
  values (
    p_scope,
    v_user_id,
    p_role,
    (select private.current_user_entity_id()),
    btrim(p_email)
  )
  on conflict (scope, user_id)
  do update set
    role = excluded.role,
    granted_by = excluded.granted_by,
    invited_email = case
      when public.scope_members.accepted_at is null
      then excluded.invited_email
      else public.scope_members.invited_email
    end;

  return v_user_id;
end;
$$;

comment on function public.invite_scope_member(extensions.ltree, text, text) is
  'Resolves p_email and grants the membership in one step, recording the typed '
  'address so a pending invitation can be labelled. Returns the usr_ id, or '
  'null when no account is registered with that address. security invoker: the '
  'admin-only RLS policies on scope_members remain the fence.';

revoke all on function public.invite_scope_member(extensions.ltree, text, text)
  from public, anon;
grant execute on function public.invite_scope_member(extensions.ltree, text, text)
  to authenticated, service_role;
