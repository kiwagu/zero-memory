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
--
-- Special considerations:
--   - The board commands write both tables with the card's own scope, so
--     they are unaffected; only a direct insert naming another scope is
--     refused.
--   - Neither table has an update policy, so an insert is the only way a row
--     gets in, and this is the only check that needs the card.

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
