-- Migration: an attachment and a history row belong to their card's scope
--
-- Purpose:
--   The insert policies on card_refs and card_events checked write access to
--   the row's own `scope` column, never that it is the scope of the card the
--   row names. The foreign key to cards ignores RLS, so a writer of one scope
--   could post an attachment or a history row onto a card of another scope it
--   may only read, and every reader of the first scope would see that row on
--   the card. Both policies now also require the row's scope to be its
--   card's.
--
-- Affected objects:
--   - policy "scope writers attach as themselves" on public.card_refs
--     (replaced)
--   - policy "scope writers append to the stream as themselves" on
--     public.card_events (replaced)
--   - table public.cards: the update grant narrows to the columns the board
--     commands change
--
-- Special considerations:
--   - The board commands write both tables with the card's own scope, so
--     they are unaffected; only a direct insert naming another scope is
--     refused.
--   - Neither child table has an update policy, so an insert is the only way
--     a row gets in there. The copy of the scope on those rows stays right
--     only while the card keeps its own scope, so the card's scope, number,
--     author and origin can no longer be updated either: the board commands
--     change the title, body, state, revision, archive stamp and updated_at,
--     and nothing else.

set search_path = public, extensions;

drop policy if exists "scope writers attach as themselves" on public.card_refs;

create policy "scope writers attach as themselves"
on public.card_refs
for insert
to authenticated
with check (
  attached_by = (select private.current_user_entity_id())
  and private.can_write(scope)
  and exists (
    select 1
      from public.cards c
     where c.id = card_refs.card_id
       and c.scope operator(extensions.=) card_refs.scope
  )
);

drop policy if exists "scope writers append to the stream as themselves"
  on public.card_events;

create policy "scope writers append to the stream as themselves"
on public.card_events
for insert
to authenticated
with check (
  actor_id = (select private.current_user_entity_id())
  and private.can_write(scope)
  and exists (
    select 1
      from public.cards c
     where c.id = card_events.card_id
       and c.scope operator(extensions.=) card_events.scope
  )
);

-- A card keeps the scope it was opened in: the rows hanging off it copy that
-- scope, and the policies above rely on the copy being right.
revoke update on public.cards from authenticated;
grant update (title, body, state, revision, updated_at, archived_at)
  on public.cards to authenticated;
