-- Migration: connected agents — see which clients hold access, and take it back
--
-- Purpose:
--   A person approves an agent on the consent screen and, until now, had no
--   way to see that approval again or to withdraw it short of changing the
--   password or turning on two-factor, both of which end every session of
--   the account. This migration gives the dashboard what it needs to list the
--   approved clients and to revoke one of them, and makes a revocation take
--   effect at once on every path to the data.
--
--   1. A session reaches the data only while it still exists. Revoking an
--      agent deletes its Auth sessions, which stops its refresh and the memory
--      server at once, but the database API only checks the token's signature,
--      so the access token in the agent's hands would otherwise keep reading
--      until it expires (up to an hour). The completeness rule now also asks
--      that the token's session still be on record. The same holds for every
--      other ended session: a sign-out, a password change, turning on
--      two-factor.
--   2. Every agent session names its client. Sessions recorded before the
--      client was kept cannot be attributed to any client, so they could be
--      neither listed nor revoked; they are ended here, and the agents that
--      held them authorize once more and get a session of their own.
--   3. Every consent names its return address. A consent recorded before
--      addresses were kept already covered no request (the client is asked
--      again), so removing it changes no behaviour and leaves no row the
--      dashboard could not describe.
--
-- Affected objects:
--   - auth.sessions, public.agent_sessions: agent sessions with no client are
--     ended and removed; public.agent_sessions.client_id becomes not null.
--   - public.oauth_consents: consents with no return address are removed;
--     redirect_uri becomes not null.
--   - private.session_complete() (replaced): also requires the session to
--     exist.
--   - public.session_assurance() (replaced): adds `live`, whether the
--     session still exists, so the dashboard and the memory server can treat
--     an ended session as signed out instead of as one that owes a code.
--   - public.connected_agents(text) (new): the clients a person approved,
--     with when each was approved and last used.
--   - public.revoke_connected_agent(text, text) (new): withdraws one
--     client's consent and ends its sessions.
--
-- Special considerations:
--   - The two new functions run with the service role only, from the
--     dashboard server, which refuses agent sessions outright. They are not
--     executable by signed-in users through the database API: an agent holds
--     a real session of the same account and must not be able to list or
--     revoke the person's agents with it.
--   - The liveness check is one primary-key lookup on auth.sessions, made
--     once per statement by the restrictive policies.

-- 1. Agent sessions without a client are ended -------------------------------------

delete from auth.sessions s
using public.agent_sessions a
where a.session_id = s.id
  and a.client_id is null;

delete from public.agent_sessions
where client_id is null;

alter table public.agent_sessions
  alter column client_id set not null;

comment on column public.agent_sessions.client_id is
  'The OAuth client the session was minted for. Revoking that client ends '
  'the session.';

-- 2. Consents without a return address are removed ---------------------------------

delete from public.oauth_consents
where redirect_uri is null;

alter table public.oauth_consents
  alter column redirect_uri set not null;

comment on column public.oauth_consents.redirect_uri is
  'The return address the person saw when approving. A repeat authorization '
  'skips the screen only when it returns there (loopback compared without the '
  'port).';

-- 3. A session reaches the data only while it exists -------------------------------

create or replace function private.session_complete()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from auth.sessions s
      where s.id = nullif((select auth.jwt() ->> 'session_id'), '')::uuid
    )
    and (
      coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
      or not exists (
        select 1
        from auth.mfa_factors f
        where f.user_id = (select auth.uid())
          and f.status = 'verified'
      )
      or exists (
        select 1
        from public.agent_sessions a
        where a.session_id
          = nullif((select auth.jwt() ->> 'session_id'), '')::uuid
      )
    );
$$;

comment on function private.session_complete() is
  'True when the calling session may reach the data: the session still '
  'exists, and it presented the second factor (aal2), or its account has no '
  'verified factor, or the authorization server opened it for an agent '
  '(recorded in agent_sessions).';

revoke all on function private.session_complete() from public, anon;
grant execute on function private.session_complete() to authenticated;

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
      from public.agent_sessions a
      where a.session_id
        = nullif((select auth.jwt() ->> 'session_id'), '')::uuid
    ),
    'live', exists (
      select 1
      from auth.sessions s
      where s.id = nullif((select auth.jwt() ->> 'session_id'), '')::uuid
    ),
    'complete', (select private.session_complete())
  );
$$;

comment on function public.session_assurance() is
  'The calling session''s standing: aal, verified_factors, agent (opened by '
  'the authorization server for an agent), live (the session still exists) '
  'and complete (may reach the data). About the caller only; the dashboard '
  'and the memory server read it before asking for data.';

revoke all on function public.session_assurance() from public, anon;
grant execute on function public.session_assurance() to authenticated;

-- 4. Listing and revoking the person's agents --------------------------------------

create or replace function public.connected_agents(p_user_id text)
returns table (
  client_id text,
  client_name text,
  redirect_uri text,
  granted_at timestamptz,
  last_used_at timestamptz,
  sessions integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.client_id,
    k.client_name,
    c.redirect_uri,
    c.granted_at,
    max(
      greatest(s.created_at, s.updated_at, s.refreshed_at at time zone 'UTC')
    ) as last_used_at,
    count(s.id)::integer as sessions
  from public.oauth_consents c
  join public.oauth_clients k on k.client_id = c.client_id
  join public.profiles p on p.id = c.user_id
  left join public.agent_sessions a
    on a.client_id = c.client_id
    and a.user_id = p.user_id
  left join auth.sessions s on s.id = a.session_id
  where c.user_id = p_user_id
    and c.revoked_at is null
  group by c.client_id, k.client_name, c.redirect_uri, c.granted_at
  order by last_used_at desc nulls last, c.granted_at desc;
$$;

comment on function public.connected_agents(text) is
  'The OAuth clients a person has approved and not revoked: name, the return '
  'address approved, when, when one of its sessions was last active, and how '
  'many sessions it holds. Service role only, called by the dashboard server '
  'with the verified caller''s id.';

revoke all on function public.connected_agents(text)
  from public, anon, authenticated;
grant execute on function public.connected_agents(text) to service_role;

create or replace function public.revoke_connected_agent(
  p_user_id text,
  p_client_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth uuid;
  v_consents integer;
  v_sessions integer;
begin
  select user_id into v_auth
  from public.profiles
  where id = p_user_id;
  if v_auth is null then
    return jsonb_build_object('revoked', false, 'sessions_ended', 0);
  end if;

  update public.oauth_consents
  set revoked_at = now()
  where user_id = p_user_id
    and client_id = p_client_id
    and revoked_at is null;
  get diagnostics v_consents = row_count;

  -- Ending the Auth session removes its refresh tokens with it, and the
  -- liveness check above shuts the access token out of the data at once.
  with ended as (
    delete from auth.sessions s
    using public.agent_sessions a
    where a.session_id = s.id
      and a.user_id = v_auth
      and a.client_id = p_client_id
    returning s.id
  )
  select count(*)::integer into v_sessions
  from ended;

  delete from public.agent_sessions
  where user_id = v_auth
    and client_id = p_client_id;

  -- A code not yet redeemed would still buy a session for the client.
  delete from public.oauth_codes
  where user_id = p_user_id
    and client_id = p_client_id;

  return jsonb_build_object(
    'revoked', v_consents > 0,
    'sessions_ended', v_sessions
  );
end;
$$;

comment on function public.revoke_connected_agent(text, text) is
  'Withdraws a person''s consent for one OAuth client and ends every session '
  'minted for it, with its unredeemed codes. The client must be approved '
  'again to reconnect. Service role only, called by the dashboard server with '
  'the verified caller''s id.';

revoke all on function public.revoke_connected_agent(text, text)
  from public, anon, authenticated;
grant execute on function public.revoke_connected_agent(text, text)
  to service_role;
