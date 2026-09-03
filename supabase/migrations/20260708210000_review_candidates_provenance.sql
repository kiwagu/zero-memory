-- Migration: add author provenance to find_review_candidates
--
-- Purpose:
--   Memories are ranked by authority (human > in-band agent > watcher). The
--   hygiene scanner must know each candidate's provenance to auto-resolve an
--   authoritative-vs-provisional conflict without queuing a human. The candidate
--   RPC previously returned only content/kind/scope; add author_kind + agent_name
--   so the scanner can compute the rank without a second round-trip.
--
-- Affected objects:
--   - function: public.find_review_candidates (drop + recreate; adds 2 cols)
--
-- Special considerations:
--   - Adding return columns changes the row type, which CREATE OR REPLACE cannot
--     do — drop the old signature first.
--   - Behaviour otherwise unchanged: same-owner neighbours, cosine >= threshold,
--     excludes self / invalidated / superseded. Security invoker, service_role.

set search_path = public, extensions;

drop function if exists public.find_review_candidates(text, double precision, int);

create or replace function public.find_review_candidates(
  p_memory_id text,
  p_min_similarity double precision default 0.78,
  p_limit int default 5
)
returns table (
  id text,
  content text,
  kind text,
  scope text,
  created_at timestamptz,
  similarity double precision,
  author_kind text,
  agent_name text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with src as (
    select memories.owner_id, memories.embedding
    from public.memories
    where memories.id = p_memory_id
  )
  select
    m.id,
    m.content,
    m.kind,
    m.scope::text as scope,
    m.created_at,
    1 - (m.embedding operator(extensions.<=>) src.embedding) as similarity,
    m.author_kind,
    m.agent_name
  from public.memories m, src
  where
    m.id <> p_memory_id
    and m.owner_id = src.owner_id
    and m.invalidated_at is null
    and m.superseded_by is null
    and m.embedding is not null
    and src.embedding is not null
    and 1 - (m.embedding operator(extensions.<=>) src.embedding) >= p_min_similarity
  order by m.embedding operator(extensions.<=>) src.embedding
  limit greatest(p_limit, 1);
$$;

comment on function public.find_review_candidates(text, double precision, int) is
  'Nearest same-owner neighbours of p_memory_id with cosine similarity >= '
  'p_min_similarity (excludes self, invalidated, and superseded rows), carrying '
  'each candidate''s author_kind/agent_name for provenance-ranked resolution. '
  'Feeds the hygiene judge. Security invoker; service_role only.';

revoke all on function public.find_review_candidates(text, double precision, int)
  from public, anon, authenticated;
grant execute on function public.find_review_candidates(text, double precision, int)
  to service_role;
