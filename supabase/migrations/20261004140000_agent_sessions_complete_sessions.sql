-- Migration: a session reaches the data only once it is complete
--
-- Purpose:
--   Two-factor authentication guarded the dashboard pages and nothing else.
--   The memory server and the database API accepted any live session of an
--   account that had turned the factor on, whether or not that session had
--   given the code. The reason was structural: the sessions the
--   authorization server opens for agents are opened with no person present
--   and stay at the first level (`aal1`) for good, so a database-wide
--   requirement of `aal2` would have stopped every agent. What was missing is
--   a way to tell an agent's session apart from a person's own sign-in that
--   has not given the code yet. This migration adds it.
--
--   A session is COMPLETE when one of three things holds:
--     1. it presented the code (`aal2`);
--     2. its account has no verified factor, so there is no code to give;
--     3. the authorization server opened it for an agent and recorded it here
--        at that moment.
--   Any other session — a person's own sign-in on an account with a factor,
--   before the code — identifies nobody and reads and writes nothing until the
--   code is given. Agents keep working exactly as before.
--
-- Affected objects:
--   - table public.agent_sessions (new): the sessions the authorization
--     server opened for agents, keyed by the Auth session id. Deny-all RLS;
--     the authorization server writes it with the service role.
--   - function private.session_complete() (new): the rule above, for the
--     calling session.
--   - function public.session_assurance() (new): the same facts as one JSON
--     object, for the dashboard and the memory server to act on before any
--     data is asked for.
--   - function private.current_user_entity_id() (replaced): null for an
--     incomplete session, so every policy and definer function that
--     identifies the caller through it sees nobody.
--   - every table under row-level security in public: a restrictive policy
--     "complete sessions only" for authenticated. Restrictive, because it
--     narrows what the permissive policies admit and can widen nothing.
--
-- Special considerations:
--   - Sessions already open when this applies are judged by the same rule.
--     Agent sessions opened before it were never recorded, so they are
--     back-filled from Auth's own record of how each session signed in: the
--     one-time sign-in link the authorization server redeems is the only way
--     a session of this product carries the `otp` method alone (the dashboard
--     offers no magic-link sign-in; a password reset arrives as `recovery`).
--     The back-fill runs once, here; from now on only the authorization
--     server adds rows, at the moment it mints a session.
--   - Every table created later under RLS needs the same restrictive policy;
--     the row-level-security authoring rule says so.
--   - `public.session_assurance()` is SECURITY DEFINER and callable by
--     `authenticated` (it reads `auth.mfa_factors`, closed to that role).
--     It returns facts about the calling session only, never about anyone
--     else; the accepted-advisor ledger records it.

-- 1. agent_sessions -------------------------------------------------------------

create table public.agent_sessions (
  -- Auth's own session id: the `session_id` claim of every token the session
  -- issues, including after a refresh. That is what the completeness rule
  -- compares against, so the row keys on it.
  session_id uuid primary key,
  -- The account the session belongs to, as Auth knows it. The rule compares
  -- Auth claims, so the row keeps Auth's id rather than the domain id.
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The OAuth client the session was minted for. Null on a row back-filled
  -- from Auth's sign-in record, which does not know the client.
  client_id text references public.oauth_clients (client_id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.agent_sessions is
  'Sessions the authorization server opened for agents, by Auth session id. '
  'A recorded session is complete without a second factor; an unrecorded '
  'first-level session on an account with a factor is not. Deny-all RLS: '
  'service-role access only, through the authorization server.';

comment on column public.agent_sessions.client_id is
  'The OAuth client the session was minted for; null on a row back-filled '
  'from Auth''s sign-in record.';

create index agent_sessions_user_id_idx
  on public.agent_sessions
  using btree (user_id);

create index agent_sessions_client_id_idx
  on public.agent_sessions
  using btree (client_id);

revoke all on public.agent_sessions from anon, authenticated;
grant select, insert, update, delete on public.agent_sessions to service_role;

alter table public.agent_sessions enable row level security;

create policy "server-only: deny all end-user access"
on public.agent_sessions
for all
to anon, authenticated
using (false)
with check (false);

-- Back-fill: sessions that signed in by the one-time link alone are agents'.
insert into public.agent_sessions (session_id, user_id, client_id)
select s.id, s.user_id, null
from auth.sessions s
where exists (
    select 1
    from auth.mfa_amr_claims c
    where c.session_id = s.id
      and c.authentication_method = 'otp'
  )
  and not exists (
    select 1
    from auth.mfa_amr_claims c
    where c.session_id = s.id
      and c.authentication_method <> 'otp'
  )
on conflict (session_id) do nothing;

-- 2. The completeness rule --------------------------------------------------------

-- In `private`, definer: it reads `auth.mfa_factors`, which `authenticated`
-- cannot. Stable, so a policy wrapping it in `(select ...)` evaluates it once
-- per statement rather than once per row.
create or replace function private.session_complete()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
    or not exists (
      select 1
      from auth.mfa_factors f
      where f.user_id = (select auth.uid())
        and f.status = 'verified'
    )
    or exists (
      select 1
      from public.agent_sessions s
      where s.session_id
        = nullif((select auth.jwt() ->> 'session_id'), '')::uuid
    );
$$;

comment on function private.session_complete() is
  'True when the calling session may reach the data: it presented the second '
  'factor (aal2), or its account has no verified factor, or the authorization '
  'server opened it for an agent (recorded in agent_sessions).';

revoke all on function private.session_complete() from public, anon;
grant execute on function private.session_complete() to authenticated;

-- The same facts for the dashboard and the memory server, which act on them
-- before any data is asked for: the level, how many verified factors the
-- account has (every type counted the same way everywhere), whether this is
-- a recorded agent session, and the verdict.
create or replace function public.session_assurance()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'aal', coalesce((select auth.jwt() ->> 'aal'), 'aal1'),
    'verified_factors', (
      select count(*)::integer
      from auth.mfa_factors f
      where f.user_id = (select auth.uid())
        and f.status = 'verified'
    ),
    'agent', exists (
      select 1
      from public.agent_sessions s
      where s.session_id
        = nullif((select auth.jwt() ->> 'session_id'), '')::uuid
    ),
    'complete', (select private.session_complete())
  );
$$;

comment on function public.session_assurance() is
  'The calling session''s standing: aal, verified_factors, agent (opened by '
  'the authorization server for an agent) and complete (may reach the data). '
  'About the caller only; the dashboard and the memory server read it before '
  'asking for data.';

revoke all on function public.session_assurance() from public, anon;
grant execute on function public.session_assurance() to authenticated;

-- 3. The identity chokepoint ------------------------------------------------------

-- Replaced: an incomplete session identifies nobody. Every policy and definer
-- function that asks "who is calling" through this function then treats the
-- session as a stranger, which is also what the restrictive policies below
-- do for the tables; definer functions are why the identity goes too.
create or replace function private.current_user_entity_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select id
  from public.profiles
  where user_id = (select auth.uid())
    and (select private.session_complete());
$$;

comment on function private.current_user_entity_id() is
  'usr_ entity id (profiles.id) of the currently authenticated user; null for '
  'a session that has not completed sign-in (an account with a second factor, '
  'before the code), so such a session identifies nobody.';

-- 4. Restrictive policy on every table under RLS ----------------------------------

do $$
declare
  t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relrowsecurity
    order by c.relname
  loop
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated '
      'using ((select private.session_complete())) '
      'with check ((select private.session_complete()))',
      'complete sessions only',
      t.relname
    );
  end loop;
end
$$;
