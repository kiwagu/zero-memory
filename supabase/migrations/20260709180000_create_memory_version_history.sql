-- Migration: memory_version_history(p_id) — the supersession lineage of a memory
--
-- Purpose:
--   memories is ADD-only: replacing a fact never overwrites it, the old row
--   stays and its `superseded_by` points at the newer version (the newer row's
--   predecessor is discoverable as `where superseded_by = <newer.id>`). The
--   detail page already links FORWARD (superseded_by), but a viewer could not
--   see the OLDER versions a memory replaced. This function returns the whole
--   linear lineage around any node — ancestors (older, superseded) + the node
--   itself + descendants (newer) — ordered oldest first, so the UI can render
--   "version history" and let the user open a superseded version.
--
-- Affected objects:
--   - function public.memory_version_history(text) (new, SECURITY INVOKER)
--
-- Special considerations:
--   - SECURITY INVOKER: the recursive scans of public.memories run with the
--     caller's RLS, so a version the caller may not see is simply omitted
--     (fail-closed). No SECURITY DEFINER, so no advisor 0029 WARN.
--   - search_path pinned to '' with every reference schema-qualified.
--   - Linear walk both ways over the superseded_by linked list; recursion
--     terminates because the chain is acyclic (a row never supersedes itself).

set search_path = public, extensions;

create or replace function public.memory_version_history(p_id text)
returns table (
  id text,
  content text,
  kind text,
  created_at timestamptz,
  invalidated_at timestamptz,
  superseded_by text,
  is_current boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive
  -- Older versions: walk backward along superseded_by until nothing points in.
  ancestors as (
    select m.id, m.superseded_by
    from public.memories m
    where m.superseded_by = p_id
    union all
    select m.id, m.superseded_by
    from public.memories m
    join ancestors a on m.superseded_by = a.id
  ),
  -- Newer versions: follow this node's superseded_by pointer forward.
  descendants as (
    select m.id, m.superseded_by
    from public.memories m
    where m.id = (
      select mm.superseded_by from public.memories mm where mm.id = p_id
    )
    union all
    select m.id, m.superseded_by
    from public.memories m
    join descendants d on m.id = d.superseded_by
  ),
  chain_ids as (
    select p_id as id
    union
    select ancestors.id from ancestors
    union
    select descendants.id from descendants
  )
  select
    m.id,
    m.content,
    m.kind,
    m.created_at,
    m.invalidated_at,
    m.superseded_by,
    (m.id = p_id) as is_current
  from public.memories m
  join chain_ids c on c.id = m.id
  order by m.created_at asc;
$$;

comment on function public.memory_version_history(text) is
  'Returns the supersession lineage around a memory (older superseded versions '
  '+ the node itself + newer versions), oldest first, is_current flags the '
  'requested node. SECURITY INVOKER: RLS-filtered to what the caller may see.';

-- Grants: authenticated calls it from the dashboard; anon gets nothing.
revoke all on function public.memory_version_history(text) from anon, authenticated;
grant execute on function public.memory_version_history(text) to authenticated, service_role;
