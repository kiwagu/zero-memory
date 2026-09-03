-- Migration: find_supersede_candidates RPC (supersede-candidate feedback on write)
--
-- Purpose:
--   Write-time read primitive that closes the cross-session recall gap: when an
--   agent stores a "new" fact that is actually a restatement of an existing one,
--   remember() surfaces the near-neighbours it may be replacing IN ITS RESPONSE,
--   so the writing agent (which holds the ground truth) can declare a supersede
--   without a separate recall. This is the same-owner band BELOW write-time dedup
--   (find_similar_memory, same-scope >= 0.92) and above a PRECISION floor (0.88).
--   Prevention here = one fewer near-duplicate pair for the hygiene judge later.
--
--   The pre-write analogue of find_review_candidates: that one takes an existing
--   p_memory_id (post-write, service_role only, for the hygiene scanner); this one
--   takes a query_embedding (the not-yet-written memory's vector) and is callable
--   by the authenticated owner in-band during remember().
--
-- Affected objects:
--   - function: public.find_supersede_candidates (security invoker)
--
-- Special considerations:
--   - Candidates are restricted to the SAME owner (private.current_user_entity_id):
--     you never supersede another user's memory, and in a shared project scope an
--     RLS-visible row may belong to a co-member — the owner filter keeps the hint
--     to the caller's own knowledge. Security invoker: RLS applies as a backstop.
--   - Band is half-open [min_similarity, max_similarity): the upper bound excludes
--     rows write-time dedup already handles (>= 0.92, incl. the identical vector of
--     the row about to be written); the default lower bound 0.88 is PRECISION-first
--     (no LLM judge sits between this probe and the agent, unlike the hygiene
--     scanner, so a lower floor would flood the agent with same-domain noise —
--     measured on the live corpus: genuine supersede pairs have median cosine 0.88,
--     while >= 0.78 matches nearly the whole owner corpus).
--   - Excludes invalidated and already-superseded rows (dead knowledge is not a
--     supersede target). Over-fetches (p_limit default 8) so the caller can apply
--     the cross-project pair filter and still cap to a few live candidates.
--   - `source` is returned so the caller can run the deterministic cross-project
--     pair filter (provenance-derived project identity) before showing a candidate.
--   - vector(384) parameter typmod is cosmetic: Postgres does not enforce a typmod
--     on function parameters, so this accepts the live 1024-dim argument unchanged,
--     exactly like every sibling search function (see 20260710190000).
--   - search_path pinned to '' with vector operators fully qualified.

set search_path = public, extensions;

create or replace function public.find_supersede_candidates(
  query_embedding extensions.vector (384),
  min_similarity double precision default 0.88,
  max_similarity double precision default 0.92,
  p_limit int default 8
)
returns table (
  id text,
  content text,
  kind text,
  scope text,
  source jsonb,
  created_at timestamptz,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    m.id,
    m.content,
    m.kind,
    m.scope::text as scope,
    m.source,
    m.created_at,
    1 - (m.embedding operator(extensions.<=>) query_embedding) as similarity
  from public.memories m
  where
    m.owner_id = (select private.current_user_entity_id())
    and m.invalidated_at is null
    and m.superseded_by is null
    and m.embedding is not null
    and 1 - (m.embedding operator(extensions.<=>) query_embedding) >= min_similarity
    and 1 - (m.embedding operator(extensions.<=>) query_embedding) < max_similarity
  order by m.embedding operator(extensions.<=>) query_embedding
  limit greatest(p_limit, 1);
$$;

comment on function public.find_supersede_candidates(
  extensions.vector, double precision, double precision, int
) is
  'Same-owner near-neighbours of query_embedding in the half-open cosine band '
  '[min_similarity, max_similarity) (default [0.88, 0.92)), excluding '
  'invalidated and superseded rows. Feeds supersede-candidate feedback in the '
  'remember() response so a writing agent can declare a supersede in-band. The '
  '0.88 floor is precision-first (no judge before the agent). '
  'Security invoker; RLS applies.';

revoke all on function public.find_supersede_candidates(
  extensions.vector, double precision, double precision, int
) from public, anon;

grant execute on function public.find_supersede_candidates(
  extensions.vector, double precision, double precision, int
) to authenticated, service_role;
