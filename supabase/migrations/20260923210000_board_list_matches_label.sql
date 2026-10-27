-- Migration: the board finds a card by its label as well as its title
--
-- Purpose:
--   A card is called ZM-N everywhere — on the board, in briefings and in the
--   squash commit that lands its work — yet the board's query matched titles
--   only, so the one name a person copies from a commit found nothing. A
--   query shaped like a label (`ZM-42`, `#42` or a bare `42`, any case,
--   surrounding blanks ignored) now also matches the card's number; the
--   title match stays, so `42` still finds a title that contains it.
--
-- Affected objects:
--   - function public.board_list: the query also matches the card number
--
-- Special considerations:
--   - The signature is unchanged, so `create or replace` keeps its grants and
--     comment; a caller that passes no query reads exactly what it read
--     before.
--   - Numbers are per project. Listed across every board the reader can see,
--     `ZM-1` finds card 1 of each, which is what the label means there.
--   - The totals stay the board's own size per column: a query narrows the
--     cards shown, not the board.

set search_path = public, extensions;

create or replace function public.board_list(
  p_scope text default null,
  p_state text default null,
  p_query text default null,
  p_include_archived boolean default false,
  p_limit integer default 50
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
  v_cards jsonb;
  v_totals jsonb;
begin
  select coalesce(jsonb_agg(row order by row.updated_at desc), '[]'::jsonb)
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
                  limit 1)
             ) as row,
             c.updated_at
        from public.cards c
       where (p_scope is null
              or c.scope operator(extensions.=) p_scope::extensions.ltree)
         and (p_state is null or c.state = p_state)
         and (p_include_archived or c.archived_at is null)
         and (p_query is null or btrim(p_query) = ''
              or c.title ilike '%' || btrim(p_query) || '%'
              or c.number = v_number)
       order by c.updated_at desc
       limit v_limit
    ) row;

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
