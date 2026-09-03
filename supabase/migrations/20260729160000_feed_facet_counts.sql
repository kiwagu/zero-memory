-- Migration: feed_facet_counts RPC (memory feed filter facets follow the selection)
--
-- Purpose:
--   The feed's filter row offers four independent lists (kind, visibility,
--   scope, lifecycle status), so a combination that is empty on the caller's
--   corpus looks exactly like the one carrying all the data — the user finds
--   out only by selecting it and getting an empty feed. This function returns,
--   in one roundtrip, how many memories each facet value would yield under the
--   CURRENT selection, so the dashboard can annotate every option with its
--   count and grey out the ones that lead nowhere.
--
-- Affected objects:
--   - function: public.feed_facet_counts(text, text, text, text, text, text)
--     (new, security invoker)
--
-- Special considerations:
--   - SECURITY INVOKER with search_path pinned to '': RLS on public.memories
--     applies, so the counts describe exactly the rows the caller may read and
--     never disclose the existence of anyone else's memories.
--   - FACET SEMANTICS: every facet is counted with all the OTHER filters
--     applied but its own ignored. Counting a facet under its own selection
--     would zero every alternative and make switching away impossible.
--   - Only non-empty values are returned. The caller knows the full value list
--     and reads an absent value as zero, which keeps the payload small when a
--     narrow selection empties most of the corpus.
--   - The status buckets are the SQL twin of the feed's client-side predicate:
--     live = never retired; superseded = retired AND replaced by a successor;
--     invalidated = retired with nothing replacing it; active = live +
--     invalidated (the default view, which deliberately keeps a lone
--     invalidation visible because a disappearance without a successor is the
--     only observable trace of a wrongly retired memory); all = everything.
--   - An unrecognized p_status degrades to the default bucket, mirroring the
--     way the web layer parses the URL parameter.

set search_path = public;

create or replace function public.feed_facet_counts(
  p_kind text default null,
  p_visibility text default null,
  p_scope text default null,
  p_status text default 'active',
  p_q text default null,
  p_id_prefix text default null
)
returns table (facet text, value text, total bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with params as (
    select case
      when coalesce(p_status, 'active') in (
        'live', 'active', 'superseded', 'invalidated', 'all'
      ) then coalesce(p_status, 'active')
      else 'active'
    end as status
  ),
  -- The search terms narrow every facet alike, so they are applied once here:
  -- an id (or a pasted fragment of one) matches by prefix, anything else by
  -- content, exactly as the feed query itself does.
  matched as (
    select
      m.kind,
      m.visibility,
      m.scope::text as scope,
      m.invalidated_at is null as is_live,
      m.superseded_by is not null as is_replaced
    from public.memories m
    where (p_id_prefix is null or pg_catalog.starts_with(m.id, p_id_prefix))
      and (p_q is null or m.content ilike '%' || p_q || '%')
  ),
  flagged as (
    select
      matched.kind,
      matched.visibility,
      matched.scope,
      matched.is_live,
      matched.is_replaced,
      (p_kind is null or matched.kind = p_kind) as kind_ok,
      (p_visibility is null or matched.visibility = p_visibility)
        as visibility_ok,
      (p_scope is null or matched.scope = p_scope) as scope_ok,
      case params.status
        when 'all' then true
        when 'live' then matched.is_live
        when 'active' then (matched.is_live or not matched.is_replaced)
        when 'superseded' then (not matched.is_live and matched.is_replaced)
        when 'invalidated' then
          (not matched.is_live and not matched.is_replaced)
      end as status_ok
    from matched
    cross join params
  )
  select 'kind'::text, flagged.kind, count(*)
  from flagged
  where flagged.visibility_ok and flagged.scope_ok and flagged.status_ok
  group by flagged.kind
  union all
  select 'visibility'::text, flagged.visibility, count(*)
  from flagged
  where flagged.kind_ok and flagged.scope_ok and flagged.status_ok
  group by flagged.visibility
  union all
  select 'scope'::text, flagged.scope, count(*)
  from flagged
  where flagged.kind_ok and flagged.visibility_ok and flagged.status_ok
  group by flagged.scope
  union all
  -- The status facet counts every bucket at once: its own selection is ignored
  -- (that is what lets the user move between buckets), the rest still narrow.
  select 'status'::text, bucket.value, count(*)
  from flagged
  cross join (
    values ('live'), ('active'), ('superseded'), ('invalidated'), ('all')
  ) as bucket (value)
  where flagged.kind_ok and flagged.visibility_ok and flagged.scope_ok
    and case bucket.value
      when 'all' then true
      when 'live' then flagged.is_live
      when 'active' then (flagged.is_live or not flagged.is_replaced)
      when 'superseded' then (not flagged.is_live and flagged.is_replaced)
      when 'invalidated' then
        (not flagged.is_live and not flagged.is_replaced)
    end
  group by bucket.value;
$$;

comment on function public.feed_facet_counts(
  text, text, text, text, text, text
) is
  'Per-value memory counts for the feed filter facets under the current '
  'selection (RLS applies). Each facet is counted with the other filters '
  'applied and its own ignored; empty values are omitted.';

revoke all on function public.feed_facet_counts(
  text, text, text, text, text, text
) from public, anon;

grant execute on function public.feed_facet_counts(
  text, text, text, text, text, text
) to authenticated;
