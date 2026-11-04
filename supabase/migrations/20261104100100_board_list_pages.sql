-- Migration: a board list pages on, past its first page
--
-- Purpose:
--   A board list read through MCP was one page with no way past it: the
--   listing said nothing about the cards beyond its limit. It now pages: a
--   caller passes the cursor the previous page returned (p_before) and gets
--   the cards after it. Each page says whether more follow (has_more) and
--   where the next one starts (next_before). The cursor is the last card's
--   change time and id, so cards that changed in the same instant keep one
--   order and none is skipped or repeated.
--
-- Affected objects:
--   - function public.board_list: + p_before (dropped and recreated: the
--     signature changes); the order gains the card id as its tie-break; the
--     result gains has_more and next_before.
--
-- Special considerations:
--   - SECURITY INVOKER, as before: the caller's RLS decides which cards exist
--     for them.
--   - The cursor reads "<updated_at as the listing renders it>|<card id>". A
--     cursor that does not parse is refused as invalid rather than read as
--     "from the start", which would hand back the first page again.
--   - Without p_before the first page is exactly what it was, now ordered
--     with a tie-break.

set search_path = public, extensions;

drop function if exists public.board_list(
  text, text, text, boolean, integer, text, text, boolean);

create function public.board_list(
  p_scope text default null,
  p_state text default null,
  p_query text default null,
  p_include_archived boolean default false,
  p_limit integer default 50,
  p_related_to text default null,
  p_relation text default 'any',
  p_worked_by_me boolean default false,
  p_before text default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  -- A query shaped like a card's label — ZM-42, #42 or a bare 42 — also
  -- names a card number. A label is per project, so across every board it
  -- finds that number on each one.
  v_number integer := (
    select m[1]::integer
      from regexp_match(btrim(coalesce(p_query, '')),
                        '^(?:zm-|#)?([0-9]{1,9})$', 'i') as m
  );
  v_mine boolean := coalesce(p_worked_by_me, false);
  v_horizon integer := private.continuation_horizon_days();
  v_cards jsonb;
  v_totals jsonb;
  v_related text;
  v_before_at timestamptz;
  v_before_id text;
  v_has_more boolean;
  v_next text;
begin
  -- Where the previous page ended. A cursor that does not parse is refused:
  -- reading it as "from the start" would serve the first page again.
  if p_before is not null then
    v_before_id := nullif(split_part(p_before, '|', 2), '');
    begin
      v_before_at := split_part(p_before, '|', 1)::timestamptz;
    exception when others then
      v_before_at := null;
    end;
    if v_before_at is null or v_before_id is null then
      return jsonb_build_object('error', 'invalid',
        'message', 'before is the next_before a previous page returned.');
    end if;
  end if;

  -- Narrowed to the cards related to one card: above it (its parent, its
  -- blockers, what it depends on), below it (its children, what it blocks,
  -- what depends on it) or any relation at all.
  if coalesce(p_relation, 'any') not in ('any', 'above', 'below') then
    return jsonb_build_object('error', 'invalid',
      'message', 'relation is any, above or below.');
  end if;
  if p_related_to is not null then
    v_related := case
      when p_scope is not null
        then private.card_ref_resolve(p_scope::extensions.ltree, p_related_to)
      else (select c.id from public.cards c where c.id = p_related_to)
    end;
    if v_related is null then
      return jsonb_build_object('error', 'not_found',
        'message', format('No card %s here, or none you can see.',
                          p_related_to));
    end if;
  end if;

  -- One order everywhere, the board's own: the caller's cards are listed
  -- like the board lists them.
  select coalesce(jsonb_agg(listed.card
                            order by listed.updated_at desc, listed.id desc),
                  '[]'::jsonb)
    into v_cards
    from (
      select jsonb_build_object(
               'id', c.id,
               'scope', c.scope::text,
               'number', c.number,
               'title', c.title,
               'state', c.state,
               'severity', c.severity,
               'type', c.type,
               'updated_at', c.updated_at,
               'archived_at', c.archived_at,
               'refs', (select count(*) from public.card_refs r
                         where r.card_id = c.id),
               'last_event', case
                 when le.created_at is null then null
                 else jsonb_build_object(
                        'type', le.type, 'reason', le.reason,
                        'created_at', le.created_at)
               end,
               -- The latest production state that carried the card.
               'released_in', (
                 select e.release_version from public.card_events e
                  where e.card_id = c.id and e.type = 'released'
                  order by e.seq desc limit 1),
               -- WHY the card sits in this column, which is a different
               -- question from what happened to it last: an attachment or a
               -- note carries no reason, and a board whose tiles showed the
               -- latest touch would hide the justification behind it.
               'state_reason', (
                 select e.reason
                   from public.card_events e
                  where e.card_id = c.id
                    and e.type in ('moved', 'archived')
                  order by e.seq desc
                  limit 1),
               -- A live blocker that is neither done nor archived holds it.
               'blocked', exists (
                 select 1 from public.card_links l
                   join public.cards o on o.id = l.src_card_id
                  where l.dst_card_id = c.id and l.type = 'blocks'
                    and l.invalidated_at is null
                    and o.state <> 'done' and o.archived_at is null),
               'links', (select count(*) from public.card_links l
                          where l.invalidated_at is null
                            and (l.src_card_id = c.id or l.dst_card_id = c.id))
             )
             -- Whether the card went quiet past the horizon: by its last
             -- event, anyone's, or among the caller's own cards by the
             -- caller's last work, the age a briefing counts.
             || jsonb_build_object(
                  'past_horizon', coalesce(
                    case when v_mine then m.created_at else le.created_at end
                      <= now() - make_interval(days => v_horizon),
                    false))
             -- The caller's own latest step: only when they asked for
             -- their cards.
             || case when v_mine then jsonb_build_object(
                  'my_last', jsonb_build_object(
                    'type', m.type,
                    'from_state', m.from_state,
                    'to_state', m.to_state,
                    'text', m.said,
                    'created_at', m.created_at))
                else '{}'::jsonb end as card,
             c.updated_at,
             c.id
        from public.cards c
        left join lateral (
          select e.type, e.reason, e.created_at
            from public.card_events e
           where e.card_id = c.id
           order by e.seq desc
           limit 1
        ) le on true
        left join (
          select distinct on (w.card_id)
                 w.card_id, w.seq, w.type, w.from_state, w.to_state, w.said,
                 w.created_at
            from private.card_own_work(p_scope) w
           where v_mine
           order by w.card_id, w.created_at desc, w.seq desc
        ) m on m.card_id = c.id
       where (p_scope is null
              or c.scope operator(extensions.=) p_scope::extensions.ltree)
         and (p_state is null or c.state = p_state)
         and (p_include_archived or c.archived_at is null)
         and (p_query is null or btrim(p_query) = ''
              or c.title ilike '%' || btrim(p_query) || '%'
              or c.number = v_number)
         and (v_related is null
              or c.id in (select r.card_id
                            from private.card_related_ids(
                                   v_related, coalesce(p_relation, 'any')) r))
         -- Only the cards with the caller's own work, when asked for.
         and (not v_mine or m.card_id is not null)
         -- Past the previous page's last card, in the listing's own order.
         and (v_before_at is null
              or (c.updated_at, c.id) < (v_before_at, v_before_id))
       order by c.updated_at desc, c.id desc
       -- One card past the page says whether another page follows.
       limit v_limit + 1
    ) listed;

  v_has_more := jsonb_array_length(v_cards) > v_limit;
  if v_has_more then
    v_cards := v_cards - v_limit;
    v_next := (v_cards -> (v_limit - 1) ->> 'updated_at')
              || '|' || (v_cards -> (v_limit - 1) ->> 'id');
  end if;

  select coalesce(jsonb_object_agg(state, n), '{}'::jsonb)
    into v_totals
    from (
      select c.state, count(*) as n
        from public.cards c
       where (p_scope is null
              or c.scope operator(extensions.=) p_scope::extensions.ltree)
         and c.archived_at is null
       group by c.state
    ) t;

  return jsonb_build_object('cards', v_cards, 'totals', v_totals,
                            'horizon_days', v_horizon,
                            'has_more', v_has_more,
                            'next_before', v_next);
end;
$$;

comment on function public.board_list(
  text, text, text, boolean, integer, text, text, boolean, text) is
  'List cards, optionally one scope, state or query; optionally only the cards '
  'related to one card (p_related_to: id, or label with p_scope) above it, '
  'below it or on any side; optionally only the cards the caller worked on '
  '(p_worked_by_me), in the same order and with no horizon, each with the '
  'caller''s latest step (my_last). Newest change first, the card id breaking '
  'ties; a page holds p_limit cards, says whether more follow (has_more) and '
  'where the next page starts (next_before, passed back as p_before). Each '
  'card says whether it is blocked, how many relations it has, and whether it '
  'went quiet past the horizon (past_horizon); the listing names the horizon '
  '(horizon_days).';

revoke all on function public.board_list(
  text, text, text, boolean, integer, text, text, boolean, text)
  from public, anon;

grant execute on function public.board_list(
  text, text, text, boolean, integer, text, text, boolean, text)
  to authenticated, service_role;
