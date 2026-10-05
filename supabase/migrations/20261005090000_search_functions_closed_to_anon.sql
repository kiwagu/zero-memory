-- Migration: the search and history functions answer signed-in callers only
--
-- Purpose:
--   `search_memories`, `find_similar_memory` and `memory_version_history` are
--   meant for signed-in callers and the server, and their earlier migrations
--   said so by revoking them from `anon`. That revoke never took effect:
--   Postgres grants EXECUTE on every new function to PUBLIC, `anon` inherits
--   it through PUBLIC, and two of the three were even granted to `anon`
--   explicitly. An anonymous caller could run all three. Row-level security
--   still returned nothing to them, so no memory was exposed, but each call
--   ran a full vector search against the database for nobody.
--
--   This takes EXECUTE away from PUBLIC and `anon` and states the intended
--   grant explicitly: signed-in users and the service role.
--
-- Affected objects:
--   - function public.search_memories(vector, text, ltree[], integer, text[])
--   - function public.find_similar_memory(vector, ltree, double precision,
--     vector[], double precision)
--   - function public.memory_version_history(text)
--
-- Special considerations:
--   - No behaviour changes for any caller that was ever meant to use these:
--     the memory server calls them as the signed-in user, and the dashboard
--     reads history as the signed-in user too.

revoke execute on function public.search_memories(
  extensions.vector, text, extensions.ltree[], integer, text[]
) from public, anon;
grant execute on function public.search_memories(
  extensions.vector, text, extensions.ltree[], integer, text[]
) to authenticated, service_role;

revoke execute on function public.find_similar_memory(
  extensions.vector,
  extensions.ltree,
  double precision,
  extensions.vector[],
  double precision
) from public, anon;
grant execute on function public.find_similar_memory(
  extensions.vector,
  extensions.ltree,
  double precision,
  extensions.vector[],
  double precision
) to authenticated, service_role;

revoke execute on function public.memory_version_history(text)
  from public, anon;
grant execute on function public.memory_version_history(text)
  to authenticated, service_role;
