-- Migration: drop the stray two-argument entity id generator
--
-- Purpose:
--   One long-running database carries a second overload,
--   `public.entity_id_generate(prefix text, ms bigint)`, that this migration
--   series never creates: a stack built from the series has only the
--   one-argument form. It was applied by hand at some point and then went
--   unused — nothing in the codebase calls it, no column default references
--   it, and the generated database types describe only the single-argument
--   signature.
--
--   An unused overload is harmless until the day someone adds a call with a
--   second argument and gets different behaviour on different stacks. The
--   point of dropping it is reproducibility: a database should be what the
--   series says it is, and nothing else.
--
-- Affected objects:
--   - function public.entity_id_generate(text, bigint) (DROP, if present)
--
-- Special considerations:
--   - The one-argument `entity_id_generate(text)` is the live generator behind
--     every domain table's primary key default and is NOT touched here. The
--     signature below names both argument types precisely so overload
--     resolution cannot reach it.
--   - `if exists` makes this a no-op on every stack built from the series,
--     which is all of them except the one that drifted. It is meant to be
--     boring everywhere.
--   - Checked before writing: no column default, generated column, index, or
--     view expression on the drifted database depends on the two-argument
--     form, so the drop cannot cascade into data.

set search_path = public, extensions;

drop function if exists public.entity_id_generate(text, bigint);
