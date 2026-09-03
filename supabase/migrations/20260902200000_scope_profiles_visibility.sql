-- Migration: scope the profiles read and drop the roster lookups
--
-- Purpose:
--   public.profiles was readable in full by every authenticated user
--   (`for select to authenticated using (true)`, created together with the
--   table). Since profiles mirrors auth.users 1:1, that predicate let any
--   signed-in account enumerate the whole user roster over PostgREST — auth
--   uuid, usr_ entity id and signup time for every account on the instance.
--   This replaces it with a predicate that admits only the caller and the
--   people whose membership rows the caller can already read, and gives the
--   two application flows that legitimately needed other users' identities a
--   narrow RPC each, so neither has to list accounts.
--
-- Affected objects:
--   - function: private.covisible_user_ids()                    (definer, new)
--   - policy:   public.profiles "profiles are readable by authenticated users"
--               DROPPED, replaced by "profiles are readable by self and
--               co-members"
--   - function: public.resolve_scope_member_candidate(extensions.ltree, text)
--               (definer, new)
--   - function: public.scope_member_identities()                (definer, new)
--
-- Special considerations:
--   - The co-membership test MUST live in a SECURITY DEFINER helper rather
--     than inline in the policy. Written inline it reads public.scope_members
--     as the caller, whose own SELECT policy already hides other members'
--     rows — the predicate would silently evaluate FALSE and the policy would
--     deny everything while looking correct.
--   - Adding a member by e-mail resolves a person who is BY DEFINITION not yet
--     a co-member, so it cannot go through the new policy. It goes through
--     resolve_scope_member_candidate instead, which answers for ONE address at
--     a time and only for an administrator of the target scope. Resolving a
--     known address to an id is a strictly weaker capability than listing
--     accounts, and it is the only one the flow needs.
--   - Both new public functions are deliberately REST-callable by
--     `authenticated` (accepted advisor residue, recorded in the advisor
--     baseline); `anon` gets nothing. They pin `set search_path = ''` and
--     fully qualify every reference.

-- Keep ltree operators resolvable while this file runs; the functions below
-- still pin their own search_path. Session-level `set` (not `set local`): the
-- CLI applies statements outside an explicit transaction block.
set search_path = public, extensions;

-- 1. who a caller may see at all --------------------------------------------

-- The usr_ ids the current user may resolve to a person: themselves, plus
-- everyone who shares a scope with them (a member of any scope in
-- private.visible_scopes()) or who sits inside a subtree they administer.
-- Nobody else — an account with no scope in common with the caller stays
-- invisible, which is what ends the enumeration.
--
-- security definer because it reads scope_members, whose own policy hides
-- other members' rows from a plain caller; in `private`, which PostgREST does
-- not expose; stable so the planner hoists it to one evaluation per statement.
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
      scope_members.scope operator(extensions.=) any (
        (select private.visible_scopes())::extensions.ltree[]
      )
      or private.is_scope_admin(scope_members.scope)
  ) as covisible
  where covisible.user_id is not null;
$$;

comment on function private.covisible_user_ids() is
  'usr_ ids the current user may resolve: self plus every member of a scope '
  'whose membership rows the caller can read. Used by RLS on public.profiles.';

revoke all on function private.covisible_user_ids() from public, anon;
grant execute on function private.covisible_user_ids() to authenticated;

-- 2. profiles: from the whole roster to self + co-members --------------------

-- The original policy admitted every authenticated caller to every row. It was
-- written when profiles held nothing but the id mapping; the mapping is still
-- the whole table, but a full listing of it IS the instance's user roster, and
-- an account learning who else exists here is a disclosure in its own right.
drop policy if exists "profiles are readable by authenticated users"
  on public.profiles;

-- Array membership rather than an inline exists(): the scalar subquery stays
-- in expression position (one InitPlan per statement) instead of being
-- re-evaluated per row, the same shape the memories select policy uses.
create policy "profiles are readable by self and co-members"
on public.profiles
for select
to authenticated
using ( id = any ((select private.covisible_user_ids())::text[]) );

-- 3. resolve ONE address, for an administrator of ONE scope ------------------

-- The member-add flow needs to turn an address the admin typed into the usr_
-- id that scope_members stores. It must not need a listing to do so: this
-- returns at most one id, only to a caller who administers the target scope,
-- and nothing at all when no such account exists. A caller can therefore
-- confirm or deny one address they already chose to type — they cannot walk
-- the instance.
--
-- security definer: auth.users is not readable by `authenticated`, and the
-- target's profile row is deliberately invisible until the membership exists.
create or replace function public.resolve_scope_member_candidate(
  p_scope extensions.ltree,
  p_email text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id text;
begin
  if (select auth.uid()) is null then
    raise exception 'resolve_scope_member_candidate requires an authenticated user';
  end if;

  if not private.is_scope_admin(p_scope) then
    raise exception 'only an administrator of scope "%" may resolve members', p_scope;
  end if;

  select profiles.id
  into v_user_id
  from auth.users
  join public.profiles on profiles.user_id = auth.users.id
  where lower(auth.users.email) = lower(trim(p_email))
  limit 1;

  return v_user_id;
end;
$$;

comment on function public.resolve_scope_member_candidate(extensions.ltree, text) is
  'usr_ id of the account registered with p_email, or null. Callable only by '
  'an administrator of p_scope; answers for one address at a time so adding a '
  'member never requires listing accounts.';

revoke all on function public.resolve_scope_member_candidate(extensions.ltree, text)
  from public, anon;
grant execute on function public.resolve_scope_member_candidate(extensions.ltree, text)
  to authenticated, service_role;

-- 4. name the people already on screen ---------------------------------------

-- Member lists print a person, not an id. The address and the chosen display
-- name live in auth.users, which the dashboard used to read through the
-- service-role admin API — pulling every account (and every address) to label
-- a handful of members, with a page ceiling that silently truncated the answer
-- besides. This returns exactly the identities the caller may already resolve,
-- so the labels stop costing a roster and stop being capped.
create or replace function public.scope_member_identities()
returns table (user_id text, email text, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    profiles.id,
    auth.users.email::text,
    coalesce(
      nullif(
        btrim(
          coalesce(
            auth.users.raw_user_meta_data ->> 'name',
            auth.users.raw_user_meta_data ->> 'full_name',
            ''
          )
        ),
        ''
      ),
      ''
    )
  from public.profiles
  join auth.users on auth.users.id = profiles.user_id
  where profiles.id = any ((select private.covisible_user_ids())::text[]);
$$;

comment on function public.scope_member_identities() is
  'Address and display name of every user the caller may resolve (self plus '
  'members of scopes whose membership the caller can read). Lets member lists '
  'show people by name without exposing the account roster.';

revoke all on function public.scope_member_identities() from public, anon;
grant execute on function public.scope_member_identities()
  to authenticated, service_role;
