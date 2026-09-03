-- Migration: dashboard_activity — the paginated memory-activity feed RPC
--
-- Purpose:
--   Back the /activity page: a recency-sorted, paginated feed of every
--   recall/build_context call the caller (or their agents) ran against their
--   memory, each row carrying its outcome (hit / empty / error), the agent
--   principal when one was attributed, the request correlation id, and the
--   search string the client sent. Same access posture as dashboard_metrics:
--   usage_events is deny-all, so the reader is a security-definer RPC
--   hard-filtered to the caller.
--
-- Affected objects:
--   - function: public.dashboard_activity(integer, integer, integer, text)
--     -> jsonb {total, events: [{id, occurred_at, tool, agent_name,
--        request_id, query, returned, error, facts: [{id, kind, content}]}]}
--
-- Fact previews (the feed's drill-down): each event carries up to 50 of the
-- memories it surfaced (the UI reveals them in portions), resolved at READ
-- time from returned_ids. Same privacy stance as the dashboard's top facts:
-- OWNED memories come with kind and a truncated content preview; a foreign id
-- (shared-scope hit) stays id-only (kind/content null) so nothing of another
-- user's content leaks.
--
-- `query` is the search string the client sent (recall query / build_context
-- topic), stored by the emit layer since the owner-approved exception to the
-- content-free metering posture: it is the caller's own search input, and the
-- feed cannot explain an empty recall without it. Events predating that emit
-- have no key and read as null. `request_id` is the req_ correlation id.
--
-- Special considerations:
--   - Outcome semantics: a FAILED read tool emits its row flagged
--     `error: true` and without `returned`/`returned_ids` (the emit layer's
--     invariant), so: error = the flag; hit = not error and returned > 0;
--     empty = not error and returned is 0/absent (rows predating result
--     metering lack the key and read as empty).
--   - p_outcome: 'all' (default) | 'hit' | 'empty' | 'error' — mirrors the
--     page's filter tabs, applied to both the count and the page. Any other
--     value behaves as 'all' (fail-open to the unfiltered feed, never an
--     exception).
--   - p_limit is clamped to [1, 50]; p_offset to >= 0.

set search_path = public;

create or replace function public.dashboard_activity(
  p_days integer default 30,
  p_limit integer default 25,
  p_offset integer default 0,
  p_outcome text default 'all'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_usr text := private.current_user_entity_id();
  v_since timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_outcome text := case
    when p_outcome in ('hit', 'empty', 'error') then p_outcome
    else 'all'
  end;
  v_total int := 0;
  v_events jsonb := '[]'::jsonb;
begin
  if v_usr is null then
    return jsonb_build_object('total', 0, 'events', '[]'::jsonb);
  end if;

  select count(*)::int
  into v_total
  from public.usage_events e
  where e.user_id = v_usr
    and e.event_type = 'mcp_tool_call'
    and e.metadata ->> 'tool' in ('recall', 'build_context')
    and e.occurred_at >= v_since
    and (
      v_outcome = 'all'
      or v_outcome = case
        when coalesce((e.metadata ->> 'error')::boolean, false) then 'error'
        when coalesce((e.metadata ->> 'returned')::int, 0) > 0 then 'hit'
        else 'empty'
      end
    );

  select coalesce(jsonb_agg(x), '[]'::jsonb)
  into v_events
  from (
    select
      e.id,
      e.occurred_at,
      e.metadata ->> 'tool' as tool,
      e.agent_name,
      e.request_id,
      e.metadata ->> 'query' as query,
      (e.metadata ->> 'returned')::int as returned,
      coalesce((e.metadata ->> 'error')::boolean, false) as error,
      coalesce(f.facts, '[]'::jsonb) as facts
    from public.usage_events e
      cross join lateral (
        -- Up to 50 surfaced facts, in the order the recall returned them
        -- (the UI reveals them in portions of 8).
        -- Owned → kind + truncated preview; foreign → id only (left join
        -- misses on the owner condition, so kind/content stay null).
        select jsonb_agg(
          jsonb_build_object(
            'id', s.mem_id,
            'kind', s.kind,
            'content', s.preview
          )
          order by s.ord
        ) as facts
        from (
          select
            hit.mem_id,
            hit.ord,
            m.kind,
            left(m.content, 200) as preview
          from jsonb_array_elements_text(
            case
              when e.metadata ? 'returned_ids'
                then e.metadata -> 'returned_ids'
              else '[]'::jsonb
            end
          ) with ordinality as hit(mem_id, ord)
          left join public.memories m
            on m.id = hit.mem_id and m.owner_id = v_usr
          order by hit.ord
          limit 50
        ) s
      ) f
    where e.user_id = v_usr
      and e.event_type = 'mcp_tool_call'
      and e.metadata ->> 'tool' in ('recall', 'build_context')
      and e.occurred_at >= v_since
      and (
        v_outcome = 'all'
        or v_outcome = case
          when coalesce((e.metadata ->> 'error')::boolean, false) then 'error'
          when coalesce((e.metadata ->> 'returned')::int, 0) > 0 then 'hit'
          else 'empty'
        end
      )
    order by e.occurred_at desc
    limit v_limit offset v_offset
  ) x;

  return jsonb_build_object('total', v_total, 'events', v_events);
end;
$$;

comment on function public.dashboard_activity(integer, integer, integer, text) is
  'Paginated memory-activity feed for the caller: recall/build_context calls '
  'with surfaced counts, error flags, agent attribution, the request id, the '
  'search query, and up to 50 fact previews per event (owned only; foreign '
  'ids stay id-only) resolved at read time from returned_ids. Security '
  'definer over deny-all usage_events; hard-filtered to the calling user.';

-- REST-callable by signed-in users only; the function self-scopes to the JWT.
revoke all on function public.dashboard_activity(integer, integer, integer, text)
  from public, anon;
grant execute on function public.dashboard_activity(integer, integer, integer, text)
  to authenticated;
