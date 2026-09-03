-- Migration: rule_candidate_scopes RPC (rules incubator scope filter)
--
-- Purpose:
--   The /rules dashboard filters the (now paginated) candidate queue by scope.
--   Building the filter control needs the DISTINCT set of scopes across all of
--   the owner's active candidates' ranked recommendations — which lives inside
--   the suggested_scopes jsonb array and cannot be expressed as a plain
--   PostgREST select. This RPC expands and de-duplicates them server-side, so
--   the page fetches only the scope list (not every row) however large the
--   queue grows.
--
-- Affected objects:
--   - function: public.rule_candidate_scopes() (security invoker)
--
-- Special considerations:
--   - SECURITY INVOKER: the caller's RLS on rule_candidates ("owners read their
--     rule candidates") already restricts rows to the owner, so the function
--     needs no definer privileges and dodges advisor lint 0029. search_path
--     pinned to ''.
--   - Counts only pending/promoted candidates (the states the queue shows);
--     dismissed/revoked/snoozed are not offered as filters.

set search_path = public;

create or replace function public.rule_candidate_scopes()
returns table (scope text, candidate_count int)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    element->>'scope' as scope,
    count(distinct rc.id)::int as candidate_count
  from public.rule_candidates rc
  cross join lateral jsonb_array_elements(
    coalesce(rc.suggested_scopes, '[]'::jsonb)
  ) as element
  where rc.status in ('pending', 'promoted')
  group by element->>'scope'
  order by candidate_count desc, scope;
$$;

comment on function public.rule_candidate_scopes() is
  'Distinct scopes across the caller''s active (pending/promoted) rule '
  'candidates suggested_scopes, with per-scope counts. Security invoker: RLS '
  'on rule_candidates scopes the rows to the owner. Drives the /rules filter.';

revoke all on function public.rule_candidate_scopes() from public, anon;
grant execute on function public.rule_candidate_scopes() to authenticated;
