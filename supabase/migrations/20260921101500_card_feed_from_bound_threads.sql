-- Migration: a card's feed, derived from the conversations bound to it
--
-- Purpose:
--   Attaching a conversation (`card_attach` with kind `thread`) binds it to the
--   card. From then on every memory born in that conversation belongs to the
--   card's feed without being attached one by one. The feed is DERIVED on read
--   from the binding and the memory's own provenance (`source ->> 'thread'`),
--   so nothing is copied and nothing is stored beyond the attachment itself:
--   detaching the conversation empties the feed, and a memory that is retired
--   leaves it on its own.
--
-- Affected objects:
--   - function: public.card_feed (new)
--
-- Special considerations:
--   - SECURITY INVOKER, like every board read: the caller's own RLS on
--     `public.memories` decides which rows exist for them, so a member never
--     sees a memory through a card that they could not read directly.
--   - Only memories in the card's OWN scope are listed. One conversation often
--     writes to several scopes (a personal preference beside project facts);
--     the card is about the project's work, and a personal note would read as
--     part of it.
--   - Only live memories: a retired or superseded one is not part of what the
--     card currently knows.
--   - A memory already attached explicitly is listed with the attachments, not
--     a second time here.
--   - A read, never a recall: nothing here records usage or reinforcement, so a
--     memory is not strengthened merely for sitting on an open card.
--   - Pages newest first by (created_at, id), with a memory id as the cursor.
--     A cursor the caller cannot see is refused rather than read as "start
--     over", which would silently repeat a page.

set search_path = public, extensions;

create or replace function public.card_feed(
  p_card_id text,
  p_before text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_card public.cards;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_before_at timestamptz;
  v_rows jsonb;
  v_count integer;
begin
  select * into v_card from public.cards where id = p_card_id;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  if p_before is not null then
    select m.created_at into v_before_at
      from public.memories m
     where m.id = p_before;
    if not found then
      return jsonb_build_object(
        'error', 'invalid',
        'message', 'The feed cursor names no memory you can read.');
    end if;
  end if;

  select coalesce(jsonb_agg(page.item order by page.created_at desc, page.id desc),
                  '[]'::jsonb),
         count(*)
    into v_rows, v_count
    from (
      select m.id,
             m.created_at,
             jsonb_build_object(
               'memory_id', m.id,
               'kind', m.kind,
               'preview', left(m.content, 200),
               'thread', m.source ->> 'thread',
               'created_at', m.created_at
             ) as item
        from public.memories m
       where m.source ->> 'thread' in (
               select cr.target
                 from public.card_refs cr
                where cr.card_id = p_card_id
                  and cr.kind = 'thread'
             )
         and m.scope operator(extensions.=) v_card.scope
         and m.invalidated_at is null
         and m.superseded_by is null
         and not exists (
               select 1
                 from public.card_refs cr
                where cr.card_id = p_card_id
                  and cr.kind = 'memory'
                  and cr.target = m.id
             )
         and (
               v_before_at is null
               or (m.created_at, m.id) < (v_before_at, p_before)
             )
       order by m.created_at desc, m.id desc
       limit v_limit + 1
    ) page;

  -- One row past the page was fetched only to learn whether there is more.
  if v_count > v_limit then
    v_rows := v_rows - v_limit;
  end if;

  return jsonb_build_object(
    'feed', v_rows,
    'has_more', v_count > v_limit,
    'next_before', case
      when v_count > v_limit then v_rows -> (v_limit - 1) ->> 'memory_id'
      else null
    end
  );
end;
$$;

comment on function public.card_feed(text, text, integer) is
  'The memories born in the conversations bound to a card, in its own scope, '
  'live only, newest first, excluding ones attached explicitly. Derived on '
  'read under the caller''s RLS; records no usage.';

revoke all on function public.card_feed(text, text, integer) from public, anon;
grant execute on function public.card_feed(text, text, integer)
  to authenticated, service_role;
