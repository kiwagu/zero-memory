-- Migration: find_review_candidates RPC (memory-hygiene pipeline)
--
-- Purpose:
--   Read primitive for the hygiene scanner. Given one memory, returns its
--   nearest same-owner neighbours whose cosine similarity clears a floor --
--   the "close but not an exact in-scope duplicate" band that write-time dedup
--   (find_similar_memory, same-scope >= 0.92) never catches: cross-scope and
--   cross-language near-duplicates, and semantically adjacent statements that
--   may contradict or supersede each other. The scanner feeds each pair to the
--   LLM judge.
--
-- Affected objects:
--   - function: public.find_review_candidates (security invoker)
--
-- Special considerations:
--   - Candidates are restricted to the SAME owner as the source memory:
--     hygiene curates one owner's own knowledge (you cannot supersede another
--     user's memory, and different owners legitimately hold different views).
--   - SECURITY INVOKER: only the service role (which bypasses RLS) is granted
--     execute, so the scanner sees every candidate; end users get nothing.
--     search_path pinned to '' with vector operators fully qualified.
--   - Excludes the source itself, invalidated rows, and rows already
--     superseded. No upper similarity bound: cross-scope/cross-language exact
--     duplicates (which dedup missed) are exactly what hygiene must surface.

set search_path = public, extensions;

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
  similarity double precision
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
    1 - (m.embedding operator(extensions.<=>) src.embedding) as similarity
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
  'p_min_similarity (excludes self, invalidated, and superseded rows). Feeds '
  'the hygiene judge. Security invoker; granted to service_role only.';

revoke all on function public.find_review_candidates(text, double precision, int)
  from public, anon, authenticated;
grant execute on function public.find_review_candidates(text, double precision, int)
  to service_role;
