-- Migration: widen the write-time supersede-candidate aperture
--
-- Purpose:
--   The candidate probe behind remember()'s in-response hint used a half-open
--   cosine BAND [0.88, 0.92). Measured on 1433 ground-truth pairs — every
--   declared supersedes/contradicts edge in a real corpus, each one a case of
--   "when this row was written, that older row should have been surfaced" —
--   the band surfaces 29.2% of the true partners:
--     * 41.6% of partners sit BELOW the 0.88 floor and are discarded before
--       ranking, which no candidate cap can recover;
--     * 25.1% sit ABOVE the 0.92 ceiling and are seen by NOTHING — the
--       ceiling exists because write-time dedup owns that zone, but dedup
--       only auto-collapses a near-verbatim match stamped with the SAME
--       session, so cross-session pairs above 0.92 fall between the two
--       mechanisms (359 of the 1433 pairs, 85% of them same-scope).
--   The subject a memory speaks about is therefore not separable by a cosine
--   band: a floor that is high enough to be quiet is also high enough to hide
--   two fifths of genuine predecessors.
--
--   This migration turns the band into a FLOOR-PLUS-RANK aperture: the floor
--   drops to 0.80 (which keeps 1432 of the 1433 partners) and the ceiling
--   becomes optional and is left unset by the caller. What bounds the agent's
--   attention is no longer the floor but the caller's candidate cap, applied
--   to rows ordered by distance — measured coverage of the true partner by
--   rank is 82.3% at 5, 90.6% at 10 and 96.4% at 20.
--
--   The floor is kept rather than removed because it still does one job the
--   cap cannot: in a small or brand-new corpus there may be no genuinely
--   related row at all, and a bare rank cap would answer with the k nearest
--   unrelated rows. In a dense corpus the floor is effectively inert.
--
-- Affected objects:
--   - function: public.find_supersede_candidates (create or replace; same
--     signature and return type, new defaults and an optional ceiling)
--
-- Special considerations:
--   - `max_similarity` becomes NULLable and defaults to null, meaning "no
--     ceiling". Passing a value keeps the previous half-open behaviour, so
--     existing callers and tests can still pin a band explicitly.
--   - Identical vectors (similarity 1.0) are now INSIDE the aperture. That is
--     intentional and not a duplicate leak: same-scope dedup runs first in
--     remember() and returns before this probe, so what reaches here is a
--     near-identical row in a DIFFERENT scope or from a different session —
--     exactly the class the old ceiling hid.
--   - Nothing else changes: still same-owner only, still excludes invalidated
--     and already-superseded rows, still security invoker with RLS as the
--     backstop, still returns `source` so the caller can apply its
--     deterministic cross-project pair filter before showing a candidate.
--   - vector(384) parameter typmod stays cosmetic (Postgres does not enforce
--     a typmod on function parameters), as in every sibling search function.

set search_path = public, extensions;

create or replace function public.find_supersede_candidates(
  query_embedding extensions.vector (384),
  min_similarity double precision default 0.80,
  max_similarity double precision default null,
  p_limit int default 24
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
    and 1 - (m.embedding operator(extensions.<=>) query_embedding)
      >= min_similarity
    -- Optional ceiling: null means "no upper bound". A caller that passes one
    -- gets the previous half-open [min, max) semantics unchanged.
    and (
      max_similarity is null
      or 1 - (m.embedding operator(extensions.<=>) query_embedding)
        < max_similarity
    )
  order by m.embedding operator(extensions.<=>) query_embedding
  limit greatest(p_limit, 1);
$$;

comment on function public.find_supersede_candidates(
  extensions.vector, double precision, double precision, int
) is
  'Same-owner nearest neighbours of query_embedding at or above '
  'min_similarity (default 0.80), optionally capped below max_similarity '
  '(null = no ceiling), excluding invalidated and superseded rows. Feeds '
  'supersede-candidate feedback in the remember() response so a writing agent '
  'can declare a supersede in-band. The floor guards a sparse corpus; what '
  'bounds the hint in a dense one is the caller''s rank cap. '
  'Security invoker; RLS applies.';

revoke all on function public.find_supersede_candidates(
  extensions.vector, double precision, double precision, int
) from public, anon;

grant execute on function public.find_supersede_candidates(
  extensions.vector, double precision, double precision, int
) to authenticated, service_role;
