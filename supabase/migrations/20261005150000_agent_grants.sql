-- Migration: agents keep their access when the person gives the second factor
--
-- Purpose:
--   Supabase Auth deletes every session of an account below `aal2` each time
--   a second factor is verified, so the person's own sign-in with the code
--   is protected from an older, weaker session. The sessions the
--   authorization server opens for agents are `aal1` by construction, so every
--   sign-in to the dashboard with the code used to end every connected agent:
--   its refresh token was Auth's own, and Auth no longer knew it.
--
--   The authorization server now issues refresh tokens of its own. Each one
--   names a GRANT: the person's approval of one client, renewed on every
--   refresh, holding the Auth session it currently stands for. When that
--   session is gone, the server opens a new one for the same person and
--   client, as long as the grant stands. A grant ends — and the agent must be
--   approved again — when:
--     - the person revokes the agent under Connected agents;
--     - the account's password or its set of verified second factors changed
--       since the grant last held a session (a fingerprint of both is kept),
--       because those are the moments a person means to shut out whoever held
--       the account's sessions;
--     - a refresh token older than the grant's last one is presented outside
--       a short window that absorbs two refreshes racing each other: that is
--       a token that was copied, so the grant is ended rather than shared.
--
-- Affected objects:
--   - table public.agent_grants (new): one row per approved client, keyed by
--     an `agg_` id. Deny-all RLS; the authorization server reads and writes it
--     with the service role.
--   - function public.agent_credentials_fingerprint(uuid) (new): a digest of
--     the account's password hash and verified factor ids, for the server to
--     compare. Service role only; the hash itself never leaves the database.
--   - function public.revoke_connected_agent(text, text) (replaced): also ends
--     the client's grants, so a revoked agent cannot have its session renewed.
--
-- Special considerations:
--   - The table holds what a refresh needs: the current Auth refresh and
--     access tokens and a per-grant secret that signs the refresh tokens
--     handed to the client. Anyone who can read it can act as the agent, the
--     same exposure the one-time codes already carry; only the service role
--     reads it.
--   - Refresh tokens issued before this migration are Auth's own and are no
--     longer accepted by the token endpoint: each agent authorizes once more.

-- 1. Grants ---------------------------------------------------------------------------

create table public.agent_grants (
  id text primary key default public.entity_id_generate('agg')
    check (public.is_entity_id_with_prefix(id, 'agg')),
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id text not null
    references public.oauth_clients (client_id) on delete cascade,
  scope text not null,
  generation integer not null default 0 check (generation >= 0),
  token_secret text not null,
  access_token text not null,
  access_expires_at timestamptz not null,
  auth_refresh_token text not null,
  session_id uuid not null,
  credentials_fingerprint text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now(),
  revoked_at timestamptz
);

comment on table public.agent_grants is
  'A person''s approval of one OAuth client, as the authorization server '
  'carries it between refreshes: the Auth session it currently stands for, '
  'the generation of the refresh token last handed out, and the fingerprint '
  'of the account''s credentials when the grant last held a session. '
  'Deny-all RLS: service-role access only, through the authorization server.';
comment on column public.agent_grants.generation is
  'How many times the refresh token was rotated. The client holds the token '
  'of this generation; the one before it is honoured only within a short '
  'window, for two refreshes that raced.';
comment on column public.agent_grants.token_secret is
  'Per-grant key that signs the refresh tokens handed to the client, so the '
  'token of the current generation can be recomputed for a racing refresh.';
comment on column public.agent_grants.credentials_fingerprint is
  'public.agent_credentials_fingerprint() of the account when the grant last '
  'held a session. A different value means the password or the verified '
  'factors changed, and the grant is not renewed.';

create index agent_grants_user_id_idx
  on public.agent_grants
  using btree (user_id);
create index agent_grants_client_id_idx
  on public.agent_grants
  using btree (client_id);

revoke all on public.agent_grants from anon, authenticated;
grant select, insert, update, delete on public.agent_grants to service_role;

alter table public.agent_grants enable row level security;

create policy "server-only: deny all end-user access"
on public.agent_grants
for all
to anon, authenticated
using (false)
with check (false);

create policy "complete sessions only"
on public.agent_grants
as restrictive
for all
to authenticated
using ((select private.session_complete()))
with check ((select private.session_complete()));

-- 2. The credentials fingerprint -------------------------------------------------------

create or replace function public.agent_credentials_fingerprint(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(
    sha256(
      convert_to(
        coalesce(u.encrypted_password, '')
          || '|'
          || coalesce(
            (
              select string_agg(f.id::text, ',' order by f.id)
              from auth.mfa_factors f
              where f.user_id = u.id
                and f.status = 'verified'
            ),
            ''
          ),
        'UTF8'
      )
    ),
    'hex'
  )
  from auth.users u
  where u.id = p_user_id;
$$;

comment on function public.agent_credentials_fingerprint(uuid) is
  'A digest of the account''s password hash and its verified second factors. '
  'It changes when the password changes or a factor is added or removed, '
  'which is when a grant must not be renewed. Null for an unknown account. '
  'Service role only.';

revoke all on function public.agent_credentials_fingerprint(uuid)
  from public, anon, authenticated;
grant execute on function public.agent_credentials_fingerprint(uuid)
  to service_role;

-- 3. Revoking an agent ends its grants -------------------------------------------------

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
  v_grants integer;
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

  -- A grant left standing would open a new session at the agent's next
  -- refresh; it ends with the consent.
  update public.agent_grants
  set revoked_at = now()
  where user_id = v_auth
    and client_id = p_client_id
    and revoked_at is null;
  get diagnostics v_grants = row_count;

  -- Ending the Auth session removes its refresh tokens with it, and the
  -- liveness check in private.session_complete() shuts the access token out
  -- of the data at once.
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
    'revoked', v_consents > 0 or v_grants > 0,
    'sessions_ended', v_sessions
  );
end;
$$;

comment on function public.revoke_connected_agent(text, text) is
  'Withdraws a person''s consent for one OAuth client, ends its grants and '
  'every session minted for it, with its unredeemed codes. The client must be '
  'approved again to reconnect. Service role only, called by the dashboard '
  'server with the verified caller''s id.';

revoke all on function public.revoke_connected_agent(text, text)
  from public, anon, authenticated;
grant execute on function public.revoke_connected_agent(text, text)
  to service_role;
