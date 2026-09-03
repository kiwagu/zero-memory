-- Migration: widen the provider set and give Ollama an endpoint
--
-- Purpose:
--   The model layer now speaks to more vendors than the two it launched with.
--   Widen the closed set a stored credential may name, and add the one thing a
--   fixed-endpoint vendor never needed: a base URL. Only Ollama has no endpoint
--   of its own — it runs wherever the user installed it — so the URL is
--   accepted for that provider alone, and only as http(s).
--
-- Affected objects:
--   - table public.provider_credentials (widened check, new base_url column)
--   - function public.set_provider_credential (new base_url arg; Ollama is keyless)
--   - function public.provider_credential_for (now returns base_url)
--
-- Special considerations:
--   - Additive and safe on existing rows: anthropic/openai rows have a NULL
--     base_url, which the new constraint permits.
--   - Ollama is keyless: local Ollama ignores the bearer token, so a placeholder
--     secret is stored to keep the vault reference NOT NULL and the read path
--     unchanged. A remote Ollama that does want a key can still supply one.
--   - base_url is restricted to Ollama and to http(s) at the schema level, so a
--     cloud credential cannot carry an endpoint and the value cannot be a
--     non-HTTP scheme. Host-level egress control (a managed, multi-tenant
--     concern) is out of scope here, where a tenant is a single instance.

set search_path = public, extensions;

-- 1. widen the provider set ----------------------------------------------

alter table public.provider_credentials
  drop constraint if exists provider_credentials_provider_check;

alter table public.provider_credentials
  add constraint provider_credentials_provider_check
  check (provider in ('anthropic', 'openai', 'xai', 'deepseek', 'moonshot', 'ollama'));

-- 2. the one non-fixed endpoint ------------------------------------------

alter table public.provider_credentials
  add column if not exists base_url text;

-- Only Ollama may carry an endpoint, and only an http(s) one. This is the
-- schema half of keeping "your own key" from meaning "any URL": a cloud
-- credential cannot smuggle a base_url, and the scheme is pinned.
alter table public.provider_credentials
  drop constraint if exists provider_credentials_base_url_check;

alter table public.provider_credentials
  add constraint provider_credentials_base_url_check
  check (
    base_url is null
    or (provider = 'ollama' and base_url ~ '^https?://')
  );

comment on column public.provider_credentials.base_url is
  'Endpoint for a provider whose location is not fixed (Ollama). NULL for '
  'every fixed-endpoint vendor.';

-- 3. write: store a key (now with a base URL) -----------------------------

-- Both the pre-migration signature and this one are dropped, so the migration
-- is re-runnable against a database that already has the new function (e.g. a
-- rehearsal clone) rather than failing on a name that is already taken.
drop function if exists public.set_provider_credential(text, text, text, text);
drop function if exists public.set_provider_credential(text, text, text, text, text);

create function public.set_provider_credential(
  p_subject_id text,
  p_provider text,
  p_api_key text,
  p_model text default null,
  p_base_url text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_secret_id uuid;
  v_api_key text := p_api_key;
begin
  if p_provider = 'ollama' then
    -- Ollama has no endpoint of its own; the URL is the credential's substance.
    if p_base_url is null or p_base_url !~ '^https?://' then
      raise exception 'ollama requires an http(s) base url';
    end if;
    -- Keyless: local Ollama ignores the bearer token. A placeholder keeps the
    -- vault reference NOT NULL and the read path identical for every provider.
    if v_api_key is null or length(trim(v_api_key)) < 8 then
      v_api_key := 'ollama-local';
    end if;
  else
    -- Every other vendor reaches its own endpoint, so a URL here is a mistake.
    if p_base_url is not null then
      raise exception 'a base url is only accepted for ollama';
    end if;
    if v_api_key is null or length(trim(v_api_key)) < 8 then
      raise exception 'an api key is required';
    end if;
  end if;

  select secret_id into v_existing
  from public.provider_credentials
  where subject_id = p_subject_id;

  if v_existing is null then
    v_secret_id := vault.create_secret(
      v_api_key,
      'provider_credential:' || p_subject_id,
      'Model-provider key supplied by the user'
    );
  else
    perform vault.update_secret(v_existing, v_api_key);
    v_secret_id := v_existing;
  end if;

  insert into public.provider_credentials
    (subject_id, provider, secret_id, model, base_url, hint, updated_at)
  values (
    p_subject_id,
    p_provider,
    v_secret_id,
    p_model,
    p_base_url,
    right(v_api_key, 4),
    now()
  )
  on conflict (subject_id) do update set
    provider = excluded.provider,
    secret_id = excluded.secret_id,
    model = excluded.model,
    base_url = excluded.base_url,
    hint = excluded.hint,
    updated_at = now();
end;
$$;

comment on function public.set_provider_credential is
  'Stores a user-supplied provider key in Vault and records its reference. '
  'Server-only: the plaintext key is an argument here and is never returned '
  'by anything. Ollama is keyless and instead requires an http(s) base url.';

-- 4. read: the server resolving whose key to use (now with the endpoint) --

drop function if exists public.provider_credential_for(text);

create function public.provider_credential_for(p_subject_id text)
returns table (provider text, model text, api_key text, base_url text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.provider, c.model, s.decrypted_secret, c.base_url
  from public.provider_credentials c
  join vault.decrypted_secrets s on s.id = c.secret_id
  where c.subject_id = p_subject_id;
$$;

comment on function public.provider_credential_for is
  'Returns the caller-supplied key for one subject, decrypted, with the '
  'endpoint for a non-fixed-location provider. The ONLY path from Vault to the '
  'server, and the reason it is granted to service_role alone: it hands back '
  'plaintext.';

-- 5. re-lock the recreated functions -------------------------------------

revoke all on function public.set_provider_credential(text, text, text, text, text)
  from anon, authenticated, public;
revoke all on function public.provider_credential_for(text)
  from anon, authenticated, public;

grant execute on function public.set_provider_credential(text, text, text, text, text)
  to service_role;
grant execute on function public.provider_credential_for(text)
  to service_role;
