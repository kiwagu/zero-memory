-- Migration: a board tells its readers when its cards change
--
-- Purpose:
--   An open board or card page refreshes while agents work. Every change to a
--   card, and every entry appended to a card's stream, is broadcast on the
--   private channel of the card's board, `board:<scope>`. Only a reader of
--   that board may join it, so a page hears exactly the boards its reader
--   may see.
--
-- Affected objects:
--   - function private.board_broadcast_change (new, trigger)
--   - trigger cards_broadcast on public.cards (new)
--   - trigger card_events_broadcast on public.card_events (new)
--   - policy on realtime.messages (new): board readers hear their board
--
-- Special considerations:
--   - The trigger function is SECURITY DEFINER because it writes
--     realtime.messages, which no caller may write directly.
--   - Receive only: there is no insert policy, so a client cannot send on a
--     board's channel.
--   - A topic names its scope after the `board:` prefix; the policy compares
--     it as text with the scopes the reader may see, so a malformed topic is
--     simply refused.

set search_path = public, extensions;

create or replace function private.board_broadcast_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.broadcast_changes(
    'board:' || coalesce(new.scope, old.scope)::text,
    tg_op,
    tg_op,
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  -- A card that moves to another board is news on the board it left too.
  -- Compared as text: with an empty search_path the ltree operators are not
  -- in reach of `is distinct from`.
  if tg_op = 'UPDATE' and new.scope::text is distinct from old.scope::text then
    perform realtime.broadcast_changes(
      'board:' || old.scope::text,
      tg_op,
      tg_op,
      tg_table_name,
      tg_table_schema,
      new,
      old
    );
  end if;
  return coalesce(new, old);
end;
$$;

comment on function private.board_broadcast_change() is
  'Broadcasts a change to a card or its stream on the private channel of the '
  'card''s board, board:<scope>, for the pages that show that board.';

revoke all on function private.board_broadcast_change() from public, anon;

create trigger cards_broadcast
after insert or update or delete on public.cards
for each row execute function private.board_broadcast_change();

-- The stream is append-only: an insert is the only change it has.
create trigger card_events_broadcast
after insert on public.card_events
for each row execute function private.board_broadcast_change();

create policy "board readers hear their board"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) like 'board:%'
  and substr((select realtime.topic()), length('board:') + 1) = any (
        (select private.visible_scopes())::text[]
      )
);
