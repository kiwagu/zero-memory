-- Migration: make entity_id_generate self-contained before the overload is gone
--
-- Purpose:
--   Close a defect in the earlier `20260719100000` drop of the two-argument
--   `entity_id_generate(text, bigint)` overload. That migration removed the
--   overload on the premise it was unused. It is unused BY THE APPLICATION —
--   but a database could carry a one-argument `entity_id_generate(prefix)`
--   whose body DELEGATES into the two-argument form:
--
--       return public.entity_id_generate(prefix, floor(...)::bigint);
--
--   On such a database the drop leaves the one-argument generator calling a
--   function that no longer exists, and every insert that defaults an id
--   (`usage_events`, `audit_log`, memories, …) fails at once. A build created
--   fresh from this migration series never has the delegating body, so the
--   fault only surfaces on a database that drifted from the series by an
--   out-of-series hand edit.
--
--   This migration makes the fix reproducible from the series instead of by
--   hand: it recreates the one-argument generator in its canonical,
--   self-contained form (identical to `20260703020551`), THEN drops the
--   overload defensively. Order matters — the generator must stop depending
--   on the overload before the overload can be removed.
--
-- Affected objects:
--   - function public.entity_id_generate(text) (CREATE OR REPLACE, canonical)
--   - function public.entity_id_generate(text, bigint) (DROP IF EXISTS)
--
-- Special considerations:
--   - On a fresh build this is a double no-op: the generator already carries
--     this exact body and the overload was never created. It exists to
--     converge a drifted database, and to leave nothing that depends on an
--     object it then removes.
--   - The body is reproduced verbatim from the series' canonical generator so
--     the two do not drift again; `sql-sync.spec.ts` guards it against the TS
--     package.

set search_path = public, extensions;

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

-- Now that nothing depends on it, remove the overload wherever it still exists.
drop function if exists public.entity_id_generate(text, bigint);
