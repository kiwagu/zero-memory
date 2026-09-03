-- Migration: add author provenance to the remember() dedup probe
--
-- Purpose:
--   Write-time dedup used to silently return the existing memory on any >=0.92
--   same-scope match — which swallowed genuine contradictions (an antonym pair
--   like "X is blue" / "X is green" is highly similar but opposite) and let a
--   provisional memory absorb an authoritative correction. To decide whether a
--   match is a safe duplicate or something the hygiene judge must see, remember()
--   needs the existing memory's provenance. Return author_kind + agent_name.
--
-- Affected objects:
--   - function: public.find_similar_memory (drop + recreate; adds 2 cols)
--
-- Special considerations:
--   - Adding return columns changes the row type — drop the old signature first.
--   - Behaviour otherwise unchanged: nearest same-scope memory above threshold.
--     Security invoker; RLS applies.

set search_path = public, extensions;

drop function if exists public.find_similar_memory(
  extensions.vector, extensions.ltree, float
);

create or replace function public.find_similar_memory(
  query_embedding extensions.vector (384),
  scope_filter extensions.ltree,
  threshold float default 0.92
)
returns table (
  id text,
  content text,
  similarity double precision,
  author_kind text,
  agent_name text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    memories.id,
    memories.content,
    1 - (memories.embedding operator(extensions.<=>) query_embedding)
      as similarity,
    memories.author_kind,
    memories.agent_name
  from public.memories
  where
    memories.invalidated_at is null
    and memories.embedding is not null
    and memories.scope operator(extensions.=) scope_filter
    and 1 - (memories.embedding operator(extensions.<=>) query_embedding)
      >= threshold
  order by memories.embedding operator(extensions.<=>) query_embedding
  limit 1;
$$;

comment on function public.find_similar_memory(
  extensions.vector, extensions.ltree, float
) is
  'Nearest same-scope valid memory above the cosine threshold, with its '
  'author_kind/agent_name so remember() can tell a safe duplicate from a '
  'contradiction or an authoritative correction. Security invoker: RLS applies.';

revoke all on function public.find_similar_memory(
  extensions.vector, extensions.ltree, float
) from public, anon;
grant execute on function public.find_similar_memory(
  extensions.vector, extensions.ltree, float
) to authenticated, service_role;
