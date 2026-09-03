-- Migration: carry session provenance in the write-time dedup probe
--
-- Purpose:
--   remember() gains a deterministic same-session refinement collapse: two
--   AUTHORITATIVE writes of one MCP session whose cosine reaches the dedup
--   threshold (>= 0.92) are the same writer restating the same fact in one
--   conversation, so the older row is superseded by the newer one without an
--   LLM judge. The rule reads the EXISTING side's provenance `source` jsonb
--   (the stamped `session` rides there), so find_similar_memory returns it.
--
--   Deliberately NOT extended to the [0.88, 0.92) supersede band
--   (find_supersede_candidates): one session routinely writes several
--   related-but-distinct facts about one topic that land in that band, and
--   collapsing them destroys knowledge — band pairs stay agent hints.
--
-- Affected objects:
--   - function: public.find_similar_memory (drop + recreate; adds 1 col)
--
-- Special considerations:
--   - Adding a return column changes the row type — drop the old signature
--     first. Behaviour otherwise unchanged. Security invoker; RLS applies.
--   - vector(384) typmod stays cosmetic (not enforced on parameters), as in
--     every sibling search function.

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
  agent_name text,
  source jsonb
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
    memories.agent_name,
    memories.source
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
  'author_kind/agent_name/source so remember() can tell a safe duplicate '
  'from a contradiction, an authoritative correction, or a same-session '
  'refinement (source->session). Security invoker: RLS applies.';

revoke all on function public.find_similar_memory(
  extensions.vector, extensions.ltree, float
) from public, anon;
grant execute on function public.find_similar_memory(
  extensions.vector, extensions.ltree, float
) to authenticated, service_role;
