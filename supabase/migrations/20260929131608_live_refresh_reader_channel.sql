-- Migration: every reader hears one private channel, nudged when what they see changes
--
-- Purpose:
--   An open dashboard page follows the agents: the memories feed, the board
--   and a card page refresh while memories and cards change. Every reader has
--   ONE private channel, `reader:<their entity id>`, and the store nudges it
--   whenever something that reader may see changes. A nudge carries no
--   content, only which surface changed: `memories` or `board`. The page that
--   hears it fetches again on the server under row-level security, so the
--   channel never decides what a reader sees, only when to look again.
--
--   This replaces the board's channel per scope, `board:<scope>`, which
--   carried whole rows. A page showing every board or every scope had to join
--   one channel per scope, which runs into the per-client channel limit and
--   never hears a scope it has not joined yet, such as a new board's first
--   card. A memory also has per-row privacy: a private memory can sit in a
--   shared scope and be readable by its owner alone, so nothing about it may
--   reach the scope's other members. One channel per reader answers all
--   three: a page joins once, and only the readers of a changed row are
--   nudged.
--
--   Who is nudged mirrors the read policies exactly:
--   - a memory: its owner, and for a shared memory every reader of its scope;
--   - a card or a card's stream entry: every reader of the card's scope.
--   A scope's readers are the accepted members of that scope or of any scope
--   under it (a member sees every scope above their own), plus the owner of a
--   personal scope, which is the reverse of private.visible_scopes().
--
--   Nudges are sent per statement, one per reader, so a bulk change (a scope
--   rename, a batch move, a hygiene pass) nudges each reader once. An update
--   that changes only what a page never shows (a memory's embedding, the
--   translation worker's bookkeeping) nudges no one.
--
-- Affected objects:
--   - function private.scope_readers(text[]) (new)
--   - function private.nudge_readers(text, text[]) (new)
--   - functions private.memories_nudge_readers(),
--     private.cards_nudge_readers() (new, statement triggers)
--   - triggers memories_nudge_{insert,update,delete},
--     cards_nudge_{insert,update,delete}, card_events_nudge_insert (new)
--   - policy "readers hear their own channel" on realtime.messages (new)
--   - triggers cards_broadcast, card_events_broadcast, function
--     private.board_broadcast_change, policy "board readers hear their board"
--     on realtime.messages (dropped: replaced by the reader channel)
--
-- Special considerations:
--   - realtime.send, not realtime.broadcast_changes: a nudge is a custom
--     message with no row in it, on purpose.
--   - The functions are SECURITY DEFINER: they read memberships across users
--     and write realtime.messages, which no caller may do directly. They read
--     and write nothing else.
--   - Receive only: there is no insert policy on realtime.messages, so no
--     client can send on a reader's channel.
--   - Scopes travel as text: with an empty search_path the ltree operators
--     are reached by name, `operator(extensions.<@)`.

set search_path = public, extensions;

-- 1. the old per-board channel goes ----------------------------------------------

-- The board's row broadcast on `board:<scope>` is replaced by the nudge below.
-- Dropping it stops the old channel; no data lives in it, and the dashboard
-- that shipped with this migration no longer joins it.
drop trigger if exists cards_broadcast on public.cards;
drop trigger if exists card_events_broadcast on public.card_events;
drop function if exists private.board_broadcast_change();
drop policy if exists "board readers hear their board" on realtime.messages;

-- 2. who reads a scope ------------------------------------------------------------

create or replace function private.scope_readers(p_scopes text[])
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  -- A member sees their own scope and every scope above it.
  select sm.user_id
  from public.scope_members as sm
  join unnest(p_scopes) as s (scope)
    on sm.scope operator(extensions.<@) s.scope::extensions.ltree
  where sm.accepted_at is not null
  union
  -- The owner of a personal scope sees it.
  select p.id
  from public.profiles as p
  join unnest(p_scopes) as s (scope)
    on s.scope = 'user.' || replace(p.id, '.', '_');
$$;

comment on function private.scope_readers(text[]) is
  'The users who may see any of the given scopes: accepted members of the '
  'scope or of a scope under it, and the owner of a personal scope. The '
  'reverse of private.visible_scopes().';

revoke all on function private.scope_readers(text[])
  from public, anon, authenticated;

-- 3. the nudge ----------------------------------------------------------------------

create or replace function private.nudge_readers(
  p_event text,
  p_readers text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reader text;
begin
  foreach v_reader in array coalesce(p_readers, '{}') loop
    perform realtime.send('{}'::jsonb, p_event, 'reader:' || v_reader, true);
  end loop;
end;
$$;

comment on function private.nudge_readers(text, text[]) is
  'Sends a content-free nudge named p_event to the private channel of each '
  'reader, reader:<id>.';

revoke all on function private.nudge_readers(text, text[])
  from public, anon, authenticated;

-- 4. memories ------------------------------------------------------------------------

create or replace function private.memories_nudge_readers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- What a page never shows: a change to these alone nudges no one. The
  -- translation worker's bookkeeping is here too: it sweeps rows one by one.
  v_unseen constant text[] := array[
    'embedding',
    'embedding_model',
    'fts',
    'translation_status',
    'translation_attempts',
    'translation_error'
  ];
  v_owners text[];
  v_shared text[];
begin
  if tg_op = 'INSERT' then
    select
      array_agg(distinct owner_id),
      array_agg(distinct scope::text) filter (where visibility = 'shared')
    into v_owners, v_shared
    from changed_new;
  elsif tg_op = 'DELETE' then
    select
      array_agg(distinct owner_id),
      array_agg(distinct scope::text) filter (where visibility = 'shared')
    into v_owners, v_shared
    from changed_old;
  else
    -- Both sides of an update: a memory made private or moved elsewhere
    -- must leave the pages that showed it.
    with changed as (
      select o.id
      from changed_old as o
      join changed_new as n on n.id = o.id
      where (to_jsonb(o) - v_unseen) is distinct from (to_jsonb(n) - v_unseen)
    ),
    sides as (
      select owner_id, scope, visibility
      from changed_old
      where id in (select id from changed)
      union all
      select owner_id, scope, visibility
      from changed_new
      where id in (select id from changed)
    )
    select
      array_agg(distinct owner_id),
      array_agg(distinct scope::text) filter (where visibility = 'shared')
    into v_owners, v_shared
    from sides;
  end if;

  perform private.nudge_readers(
    'memories',
    array(
      select unnest(coalesce(v_owners, '{}'))
      union
      select private.scope_readers(coalesce(v_shared, '{}'))
    )
  );
  return null;
end;
$$;

comment on function private.memories_nudge_readers() is
  'Statement trigger: nudges the readers of the memories a statement changed, '
  'on their reader channel, with the `memories` event.';

revoke all on function private.memories_nudge_readers()
  from public, anon, authenticated;

create trigger memories_nudge_insert
after insert on public.memories
referencing new table as changed_new
for each statement execute function private.memories_nudge_readers();

create trigger memories_nudge_update
after update on public.memories
referencing old table as changed_old new table as changed_new
for each statement execute function private.memories_nudge_readers();

create trigger memories_nudge_delete
after delete on public.memories
referencing old table as changed_old
for each statement execute function private.memories_nudge_readers();

-- 5. the board -----------------------------------------------------------------------

create or replace function private.cards_nudge_readers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scopes text[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct scope::text) into v_scopes from changed_new;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct scope::text) into v_scopes from changed_old;
  else
    -- A card that moves to another board is news on the board it left too.
    select array_agg(distinct scope)
    into v_scopes
    from (
      select scope::text as scope from changed_old
      union
      select scope::text from changed_new
    ) as sides;
  end if;

  perform private.nudge_readers(
    'board',
    array(select private.scope_readers(coalesce(v_scopes, '{}')))
  );
  return null;
end;
$$;

comment on function private.cards_nudge_readers() is
  'Statement trigger: nudges the readers of the boards a statement changed, '
  'on their reader channel, with the `board` event.';

revoke all on function private.cards_nudge_readers()
  from public, anon, authenticated;

create trigger cards_nudge_insert
after insert on public.cards
referencing new table as changed_new
for each statement execute function private.cards_nudge_readers();

create trigger cards_nudge_update
after update on public.cards
referencing old table as changed_old new table as changed_new
for each statement execute function private.cards_nudge_readers();

create trigger cards_nudge_delete
after delete on public.cards
referencing old table as changed_old
for each statement execute function private.cards_nudge_readers();

-- The stream is append-only: an insert is the only change it has.
create trigger card_events_nudge_insert
after insert on public.card_events
referencing new table as changed_new
for each statement execute function private.cards_nudge_readers();

-- 6. who may listen -------------------------------------------------------------------

create policy "readers hear their own channel"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic())
    = 'reader:' || (select private.current_user_entity_id())
);
