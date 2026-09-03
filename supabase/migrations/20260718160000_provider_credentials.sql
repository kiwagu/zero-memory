-- Migration: per-subject model-provider credentials, kept in Vault
--
-- Purpose:
--   Let a user run metered work on their own provider key instead of the
--   platform's. Two consequences follow: their spend is billed to them by
--   their own provider, so no ceiling of ours applies to it; and the key is
--   somebody else's secret, so it must never be stored where it can be read
--   back out — not by another user, not by the dashboard, not by us.
--
-- Affected objects:
--   - table public.provider_credentials (new)
--   - function public.set_provider_credential (new)
--   - function public.provider_credential_for (new)
--   - function public.revoke_provider_credential (new)
--
-- Special considerations:
--   - The key itself lives in Vault (extension `supabase_vault`, already
--     installed), which encrypts it at rest. This table holds only a
--     reference to it plus display metadata. `anon` and `authenticated` have
--     no USAGE on the vault schema at all, so the reference is inert to them.
--   - The server reaches Postgres through PostgREST, which exposes only the
--     `public` schema — it cannot read `vault.decrypted_secrets` directly.
--     These three definer functions are that bridge, and they are the only
--     one: each is revoked from every role except `service_role`.
--   - Nothing here ever returns a key to an end user. The read function is
--     server-only; what a user can see about their own credential is the
--     provider, the model and a four-character hint.

set search_path = public, extensions;

-- 1. table ---------------------------------------------------------------

create table public.provider_credentials (
  -- One active credential per user: switching providers replaces it rather
  -- than accumulating keys nobody remembers granting.
  subject_id text primary key,
  provider text not null
    check (provider in ('anthropic', 'openai')),
  -- Reference into vault.secrets. Deliberately not a foreign key: the vault
  -- schema is owned by another role and this migration cannot take a
  -- REFERENCES grant on it. The revoke function is what keeps the two in
  -- step, and an orphaned secret is inert anyway.
  secret_id uuid not null,
  -- Optional model override; NULL means the provider's default for the task.
  model text,
  -- Last four characters, so a user can tell which key is installed without
  -- the key ever being readable. Never widen this.
  hint text not null
    check (length(hint) <= 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.provider_credentials is
  'Per-user model-provider credential. The key itself is in Vault; this row '
  'holds only its reference and display metadata. Readable by its owner '
  '(metadata only), writable by nothing except the server.';

comment on column public.provider_credentials.hint is
  'Last four characters of the key, for recognition only.';

-- 2. grants + RLS --------------------------------------------------------

revoke all on public.provider_credentials from anon, authenticated;
grant select on public.provider_credentials to authenticated;
grant select, insert, update, delete on public.provider_credentials to service_role;

alter table public.provider_credentials enable row level security;

-- A user can see that they have a key installed, which provider it is for,
-- and its hint. There is deliberately no insert/update/delete policy: with
-- RLS on and no permissive policy, every such write is denied, and the
-- service role bypasses RLS. Writes go through the functions below so the
-- key and its row are created together.
create policy "a credential is readable by its subject"
on public.provider_credentials
for select
to authenticated
using (subject_id = (select private.current_user_entity_id()));

-- 3. write: store a key ---------------------------------------------------

create or replace function public.set_provider_credential(
  p_subject_id text,
  p_provider text,
  p_api_key text,
  p_model text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_secret_id uuid;
begin
  if p_api_key is null or length(trim(p_api_key)) < 8 then
    raise exception 'an api key is required';
  end if;

  select secret_id into v_existing
  from public.provider_credentials
  where subject_id = p_subject_id;

  if v_existing is null then
    -- The secret is named after the subject so an operator auditing the
    -- vault can tell whose key it is without decrypting anything.
    v_secret_id := vault.create_secret(
      p_api_key,
      'provider_credential:' || p_subject_id,
      'Model-provider key supplied by the user'
    );
  else
    -- Replacing a key reuses the vault row, so the old value does not linger
    -- next to the new one.
    perform vault.update_secret(v_existing, p_api_key);
    v_secret_id := v_existing;
  end if;

  insert into public.provider_credentials
    (subject_id, provider, secret_id, model, hint, updated_at)
  values (
    p_subject_id,
    p_provider,
    v_secret_id,
    p_model,
    right(p_api_key, 4),
    now()
  )
  on conflict (subject_id) do update set
    provider = excluded.provider,
    secret_id = excluded.secret_id,
    model = excluded.model,
    hint = excluded.hint,
    updated_at = now();
end;
$$;

comment on function public.set_provider_credential is
  'Stores a user-supplied provider key in Vault and records its reference. '
  'Server-only: the plaintext key is an argument here and is never returned '
  'by anything.';

-- 4. read: the server resolving whose key to use --------------------------

create or replace function public.provider_credential_for(p_subject_id text)
returns table (provider text, model text, api_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.provider, c.model, s.decrypted_secret
  from public.provider_credentials c
  join vault.decrypted_secrets s on s.id = c.secret_id
  where c.subject_id = p_subject_id;
$$;

comment on function public.provider_credential_for is
  'Returns the caller-supplied key for one subject, decrypted. The ONLY path '
  'from Vault to the server, and the reason it is granted to service_role '
  'alone: it hands back plaintext.';

-- 5. revoke ---------------------------------------------------------------

create or replace function public.revoke_provider_credential(p_subject_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  delete from public.provider_credentials
  where subject_id = p_subject_id
  returning secret_id into v_secret_id;

  -- Revocation deletes the secret as well as the reference. Leaving the
  -- vault row behind would mean a user who withdrew their key still has it
  -- stored with us, which is exactly what revoking is meant to prevent.
  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;
end;
$$;

comment on function public.revoke_provider_credential is
  'Removes both the reference and the vault secret, so withdrawing a key '
  'actually withdraws it.';

-- 6. lock the functions down ---------------------------------------------

-- Every one of these is server-only. The read function returns plaintext and
-- the write functions accept it; neither belongs on a REST surface an end
-- user can reach.
revoke all on function public.set_provider_credential(text, text, text, text)
  from anon, authenticated, public;
revoke all on function public.provider_credential_for(text)
  from anon, authenticated, public;
revoke all on function public.revoke_provider_credential(text)
  from anon, authenticated, public;

grant execute on function public.set_provider_credential(text, text, text, text)
  to service_role;
grant execute on function public.provider_credential_for(text)
  to service_role;
grant execute on function public.revoke_provider_credential(text)
  to service_role;
