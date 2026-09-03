/*
 * Entity-id generator + validators — installed first so every domain table can
 * default its text primary key to `public.entity_id_generate('<prefix>')` and
 * CHECK it with `public.is_entity_id_with_prefix(id, '<prefix>')`.
 *
 * Canonical source (kept in TS ↔ SQL sync, guarded by
 * `packages/contracts/src/entity-prefixes.spec.ts`): the `entity-id` package's
 * `entity_id_generate.sql`, shipped at its `./entity_id_generate.sql` subpath.
 *
 * Contract: "<prefix>_<rand16>.<ts10>" (Crockford base32, lowercase).
 */

create extension if not exists pgcrypto with schema extensions;

create or replace function public.entity_id_crockford_alphabet()
returns text
language sql
security invoker
set search_path = ''
immutable
as $$
  select '0123456789abcdefghjkmnpqrstvwxyz'::text;
$$;

create or replace function public.entity_id_crockford_from_bits(bits bit varying)
returns text
language plpgsql
security invoker
set search_path = ''
immutable
as $$
declare
  alphabet text;
  out text := '';
  chunk bit(5);
  val int;
  i int;
  n int;
begin
  if bits is null then
    raise exception 'bits must not be null';
  end if;

  if (length(bits) % 5) <> 0 then
    raise exception 'bit length must be a multiple of 5 (got %)', length(bits);
  end if;

  alphabet := public.entity_id_crockford_alphabet();
  n := length(bits) / 5;

  for i in 0..(n - 1) loop
    chunk := substring(bits from (i * 5) + 1 for 5);
    val := chunk::int;
    out := out || substring(alphabet from val + 1 for 1);
  end loop;

  return out;
end;
$$;

create or replace function public.entity_id_encode_ts_10(ms bigint)
returns text
language plpgsql
security invoker
set search_path = ''
immutable
as $$
declare
  hex text;
  bits48 bit(48);
  bits50 bit(50);
begin
  if ms is null then
    raise exception 'ms must not be null';
  end if;
  if ms < 0 then
    raise exception 'ms must be non-negative';
  end if;

  hex := lpad(to_hex(ms), 12, '0');
  bits48 := ('x' || hex)::bit(48);
  bits50 := b'00'::bit(2) || bits48;
  return public.entity_id_crockford_from_bits(bits50);
end;
$$;

create or replace function public.entity_id_encode_rand_16(bytes bytea)
returns text
language plpgsql
security invoker
set search_path = ''
immutable
as $$
declare
  bits80 bit(80);
begin
  if bytes is null then
    raise exception 'bytes must not be null';
  end if;
  if octet_length(bytes) <> 10 then
    raise exception 'rand bytes must be exactly 10 bytes (got %)', octet_length(bytes);
  end if;

  bits80 := ('x' || encode(bytes, 'hex'))::bit(80);
  return public.entity_id_crockford_from_bits(bits80);
end;
$$;

create or replace function public.entity_id_generate(prefix text)
returns text
language plpgsql
security invoker
set search_path = ''
volatile
as $$
declare
  p text;
  ms bigint;
begin
  p := lower(trim(prefix));
  if p is null or p = '' then
    raise exception 'prefix must not be empty';
  end if;
  if p !~ '^[a-z][a-z0-9]{1,15}$' then
    raise exception 'invalid prefix "%": expected [a-z][a-z0-9]{1,15}', prefix;
  end if;

  ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  return p
    || '_'
    || public.entity_id_encode_rand_16(extensions.gen_random_bytes(10))
    || '.'
    || public.entity_id_encode_ts_10(ms);
end;
$$;

comment on function public.entity_id_generate(text) is
  'Generates "<prefix>_<rand16>.<ts10>" entity ids using Crockford base32 (lowercase).';

create or replace function public.is_entity_id(value text)
returns boolean
language sql
security invoker
set search_path = ''
immutable
as $$
  select value is not null
    and value ~ '^[a-z][a-z0-9]{1,15}_[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{16}\.[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{10}$';
$$;

create or replace function public.is_entity_id_with_prefix(value text, prefix text)
returns boolean
language sql
security invoker
set search_path = ''
immutable
as $$
  select public.is_entity_id(value)
    and value like lower(trim(prefix)) || '\_%';
$$;

comment on function public.is_entity_id(text) is
  'True when the text matches the entity-id contract "<prefix>_<rand16>.<ts10>".';
comment on function public.is_entity_id_with_prefix(text, text) is
  'True when the text is an entity id carrying the given prefix.';
