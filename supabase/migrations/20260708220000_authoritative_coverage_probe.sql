-- Migration: authoritative-coverage probe for provisional (watcher) writes
--
-- Purpose:
--   The out-of-band watcher writes are provisional. Before it writes one, it
--   asks: is this fact already represented by an AUTHORITATIVE memory (in-band
--   agent or human)? If so the watcher defers and does not write a competing
--   near-duplicate. This probe answers that from a raw embedding (pre-write),
--   unlike find_review_candidates which needs an existing memory id.
--
-- Affected objects:
--   - function: public.find_authoritative_coverage (new)
--
-- Special considerations:
--   - Security invoker: RLS scopes the search to the caller's own readable
--     memories, so a user only ever matches their own coverage.
--   - Authoritative = NOT a watcher write (`agent_name is distinct from
--     'watcher'`); this includes human (agent_name null) and in-band agent
--     writes. Excludes invalidated / superseded rows.
--   - Owner-wide (no scope filter): the same fact may live in another of the
--     caller's scopes and still cover this write.

set search_path = public, extensions;

create or replace function public.find_authoritative_coverage(
  query_embedding extensions.vector (384),
  min_similarity float default 0.85
)
returns table (
  id text,
  content text,
  similarity double precision
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
      as similarity
  from public.memories
  where
    memories.invalidated_at is null
    and memories.superseded_by is null
    and memories.embedding is not null
    -- authoritative only: exclude provisional watcher writes
    and memories.agent_name is distinct from 'watcher'
    and 1 - (memories.embedding operator(extensions.<=>) query_embedding)
      >= min_similarity
  order by memories.embedding operator(extensions.<=>) query_embedding
  limit 1;
$$;

comment on function public.find_authoritative_coverage(
  extensions.vector, float
) is
  'Nearest AUTHORITATIVE memory (not a watcher write) to a raw embedding, above '
  'min_similarity, across the caller''s readable scopes. Lets a provisional '
  'writer defer when an authoritative memory already covers the fact. Security '
  'invoker: RLS applies.';

revoke all on function public.find_authoritative_coverage(extensions.vector, float)
  from public, anon;
grant execute on function public.find_authoritative_coverage(extensions.vector, float)
  to authenticated, service_role;
