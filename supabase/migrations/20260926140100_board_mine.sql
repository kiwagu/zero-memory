-- Migration: the cards a person worked on, and what a new session is offered
--
-- Purpose:
--   The board lists, on request, the cards the caller worked on, newest own
--   work first and with no horizon, so work the briefing no longer offers
--   stays reachable. A reader of the dashboard sees the continuation offer a
--   new session would get, without asking an agent.
--
-- Affected objects:
--   - function public.board_list: + p_worked_by_me (dropped and recreated:
--     the signature changes); with it each card carries my_last and
--     past_horizon
--   - function public.board_continuation (new)
--
-- Special considerations:
--   - SECURITY INVOKER: the caller's RLS decides which cards exist for them.
--   - Without p_worked_by_me the listing is exactly what it was.

set search_path = public, extensions;

drop function if exists public.board_list(
  text, text, text, boolean, integer, text, text);

create function public.board_list(
  p_scope text default null,
  p_state text default null,
  p_query text default null,
  p_include_archived boolean default false,
  p_limit integer default 50,
  p_related_to text default null,
  p_relation text default 'any',
  p_worked_by_me boolean default false
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
begin
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

  select coalesce(jsonb_agg(listed.card
                            order by listed.my_at desc nulls last,
                                     listed.my_seq desc nulls last,
                                     listed.updated_at desc),
                  '[]'::jsonb)
    into v_cards
    from (
      select jsonb_build_object(
               'id', c.id,
               'scope', c.scope::text,
               'number', c.number,
               'title', c.title,
               'state', c.state,
               'updated_at', c.updated_at,
               'archived_at', c.archived_at,
               'refs', (select count(*) from public.card_refs r
                         where r.card_id = c.id),
               'last_event', (
                 select jsonb_build_object(
                          'type', e.type, 'reason', e.reason,
                          'created_at', e.created_at)
                   from public.card_events e
                  where e.card_id = c.id
                  order by e.seq desc
                  limit 1),
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
             -- The caller's own latest step, and whether a briefing would
             -- still count it: only when the caller asked for their cards.
             || case when v_mine then jsonb_build_object(
                  'my_last', jsonb_build_object(
                    'type', m.type,
                    'from_state', m.from_state,
                    'to_state', m.to_state,
                    'text', m.said,
                    'created_at', m.created_at),
                  'past_horizon',
                    m.created_at <= now() - make_interval(days => v_horizon))
                else '{}'::jsonb end as card,
             c.updated_at,
             m.created_at as my_at,
             m.seq as my_seq
        from public.cards c
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
       order by m.created_at desc nulls last, m.seq desc nulls last,
                c.updated_at desc
       limit v_limit
    ) listed;

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

  return jsonb_build_object('cards', v_cards, 'totals', v_totals);
end;
$$;

comment on function public.board_list(
  text, text, text, boolean, integer, text, text, boolean) is
  'List cards, optionally one scope, state or query; optionally only the cards '
  'related to one card (p_related_to: id, or label with p_scope) above it, '
  'below it or on any side; optionally only the cards the caller worked on '
  '(p_worked_by_me), newest own work first with no horizon, each with the '
  'caller''s latest step (my_last) and whether a briefing still counts it '
  '(past_horizon). Each card says whether it is blocked and how many '
  'relations it has.';

create function public.board_continuation(p_scope text default null)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'horizon_days', private.continuation_horizon_days(),
    'boards', coalesce((
      select jsonb_agg(
               jsonb_build_object('scope', b.scope, 'continuation', b.cont)
               order by b.ord)
        from (
          select s.scope, s.ord,
                 private.card_continuation(s.scope, null) as cont
            from (
              select p_scope as scope, 0::bigint as ord
               where p_scope is not null
              union all
              select x.value->>'scope', x.ord
                from jsonb_array_elements(public.board_scopes())
                       with ordinality as x(value, ord)
               where p_scope is null
            ) s
        ) b
       where b.cont is not null), '[]'::jsonb))
$$;

comment on function public.board_continuation(text) is
  'What a new session would be offered to continue, as a person reads it: '
  'for one board, or for every board the caller can see (newest activity '
  'first), the caller''s continuation with no conversation of its own. '
  'Boards with nothing to say are left out. Carries the horizon in days.';

revoke all on function public.board_list(
  text, text, text, boolean, integer, text, text, boolean) from public, anon;
revoke all on function public.board_continuation(text) from public, anon;

grant execute on function public.board_list(
  text, text, text, boolean, integer, text, text, boolean)
  to authenticated, service_role;
grant execute on function public.board_continuation(text)
  to authenticated, service_role;
