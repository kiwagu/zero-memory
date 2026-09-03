-- Migration: OAuth 2.1 authorization-server tables
--
-- Purpose:
--   Storage for the embedded MCP OAuth 2.1 authorization server
--   (packages/mcp-auth): dynamically registered clients (RFC 7591) and
--   one-time authorization codes with their PKCE challenge. Per DESIGN the
--   AS mints no tokens of its own — /token returns the Supabase session
--   obtained at login time, so the code row carries that session pair until
--   redemption.
--
-- Affected objects:
--   - table: public.oauth_clients (RLS enabled, deny-all)
--   - table: public.oauth_codes  (RLS enabled, deny-all)
--   - indexes: oauth_codes expires_at (cleanup), client_id/user_id (FK covers)
--
-- Special considerations:
--   - Deny-all RLS ON PURPOSE: both tables are enabled for RLS with NO
--     policies and NO grants to anon/authenticated. Only the service-role
--     adapter inside packages/mcp-auth may touch them; they must never be
--     reachable through the Data API as a user.
--   - oauth_codes.access_token / refresh_token hold the Supabase session of
--     the just-authenticated user for the short window (5 min TTL) between
--     the authorize redirect and the token exchange. The row is deleted on
--     redemption; the expires_at index supports periodic cleanup of
--     abandoned codes.

-- 1. oauth_clients -------------------------------------------------------------

create table public.oauth_clients (
  client_id text primary key default public.entity_id_generate('oac')
    check (public.is_entity_id_with_prefix(client_id, 'oac')),
  client_name text,
  redirect_uris text[] not null,
  -- Public clients only in v1: PKCE instead of a client secret.
  token_endpoint_auth_method text not null default 'none',
  created_at timestamptz not null default now()
);

comment on table public.oauth_clients is
  'OAuth 2.1 clients registered via dynamic client registration (RFC 7591). '
  'Deny-all RLS: service-role access only (packages/mcp-auth).';

-- Fail-closed: no API-role grants, RLS enabled with no policies.
revoke all on public.oauth_clients from anon, authenticated;
grant select, insert, update, delete on public.oauth_clients to service_role;

alter table public.oauth_clients enable row level security;

-- 2. oauth_codes ---------------------------------------------------------------

create table public.oauth_codes (
  code text primary key,
  client_id text not null
    references public.oauth_clients (client_id) on delete cascade,
  user_id text not null references public.profiles (id) on delete cascade check (public.is_entity_id_with_prefix(user_id, 'usr')),
  -- PKCE S256 challenge from the authorization request.
  code_challenge text not null,
  redirect_uri text not null,
  -- RFC 8707 resource indicator (the MCP endpoint URL).
  resource text,
  -- Supabase session captured at login; returned by /token and deleted with
  -- the row on redemption. Protected by the deny-all RLS on this table.
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.oauth_codes is
  'One-time OAuth authorization codes (5 min TTL) with their PKCE challenge '
  'and the Supabase session pair returned on redemption. Deny-all RLS: '
  'service-role access only (packages/mcp-auth).';

-- Cleanup of expired/abandoned codes.
create index oauth_codes_expires_at_idx
  on public.oauth_codes
  using btree (expires_at);

-- Covering indexes for the foreign keys (advisor lint 0001).
create index oauth_codes_client_id_idx
  on public.oauth_codes
  using btree (client_id);

create index oauth_codes_user_id_idx
  on public.oauth_codes
  using btree (user_id);

-- Fail-closed: no API-role grants, RLS enabled with no policies.
revoke all on public.oauth_codes from anon, authenticated;
grant select, insert, update, delete on public.oauth_codes to service_role;

alter table public.oauth_codes enable row level security;
