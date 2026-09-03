-- Migration: list_memory_scopes RPC (feed project/scope filter)
--
-- Purpose:
--   Backs the "filter by project" facet on the Memories feed. Returns the
--   distinct scopes present in the caller's visible memories, so the dashboard
--   can offer them by name (there are only a handful of project scopes).
--
-- Affected objects:
--   - function: public.list_memory_scopes() (security invoker)
--
-- Special considerations:
--   - SECURITY INVOKER: RLS on public.memories applies, so a caller only ever
--     sees the scopes of memories they may read. search_path pinned to ''.
--   - Invalidated memories are excluded (the feed shows active ones).

set search_path = public;

create or replace function public.list_memory_scopes()
returns setof text
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct memories.scope::text
  from public.memories
  where memories.invalidated_at is null
  order by 1;
$$;

comment on function public.list_memory_scopes() is
  'Distinct scopes of the caller''s visible active memories (RLS applies). '
  'Feeds the Memories project/scope filter.';

revoke all on function public.list_memory_scopes() from public, anon;
grant execute on function public.list_memory_scopes() to authenticated;
