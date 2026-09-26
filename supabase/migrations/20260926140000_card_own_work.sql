-- Migration: one rule for what counts as a person's work on the board
--
-- Purpose:
--   The continuation offer a briefing makes and the list of cards a person
--   worked on must agree on what that person's work is. The rule lived inside
--   private.card_continuation; it moves into one helper both read, and the
--   horizon setting moves behind a helper of its own.
--
-- Affected objects:
--   - function private.continuation_horizon_days (new)
--   - function private.card_own_work (new)
--   - function private.card_continuation: reads the helpers; output unchanged
--
-- Special considerations:
--   - SECURITY INVOKER throughout: the caller's RLS decides which events exist.

set search_path = public, extensions;

create or replace function private.continuation_horizon_days()
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(
           nullif(current_setting('zm.continuation_horizon_days', true), '')::integer,
           30)
$$;

comment on function private.continuation_horizon_days() is
  'How many days back a person''s work still counts for the continuation '
  'offer: the zm.continuation_horizon_days setting, 30 by default.';

create or replace function private.card_own_work(p_scope text)
returns table (
  card_id text,
  seq bigint,
  type text,
  from_state text,
  to_state text,
  said text,
  thread text,
  created_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select e.card_id, e.seq, e.type, e.from_state, e.to_state,
         -- One line before it is clipped, so indentation and line breaks
         -- never eat the words the excerpt is for.
         case
           when o.line is null then null
           when length(o.line) > 120 then left(o.line, 119) || '…'
           else o.line
         end,
         e.thread, e.created_at
    from public.card_events e
   cross join lateral (
     select regexp_replace(btrim(coalesce(e.reason, e.note_text)), '\s+', ' ', 'g')
              as line
   ) o
   where (p_scope is null
          or e.scope operator(extensions.=) p_scope::extensions.ltree)
     and e.actor_id = (select private.current_user_entity_id())
     and e.type in ('created', 'moved', 'edited', 'noted', 'attached',
                    'detached', 'linked', 'unlinked', 'landed')
     -- The move a release writes right after its record, in the same
     -- statement, is the release hook's step, not the caller's.
     and not (e.type = 'moved' and exists (
           select 1
             from public.card_events r
            where r.card_id = e.card_id
              and r.seq = e.seq - 1
              and r.type = 'released'
              and r.created_at = e.created_at))
$$;

comment on function private.card_own_work(text) is
  'The caller''s own work on one board, or on every board they can see: '
  'what they created, moved, edited, noted, attached, detached, linked, '
  'unlinked or landed, never what a release recorded or moved for them. '
  'No horizon and no conversation filter: each reader applies its own.';

create or replace function private.card_continuation(
  p_scope text,
  p_thread text
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with work as (
    select w.card_id, w.seq, w.type, w.from_state, w.to_state, w.said,
           w.created_at
      from private.card_own_work(p_scope) w
      join public.cards c on c.id = w.card_id
     where (p_thread is null or w.thread is distinct from p_thread)
       and w.created_at > now() - make_interval(
             days => private.continuation_horizon_days())
       and c.archived_at is null
  ),
  newest as (
    select w.card_id, w.type, w.to_state
      from work w
     order by w.created_at desc, w.seq desc
     limit 1
  ),
  offer as (
    select w.card_id
      from work w
      join public.cards c on c.id = w.card_id
     where c.state = 'active'
     order by w.created_at desc, w.seq desc
     limit 1
  )
  select case when not exists (select 1 from newest) then null
  else jsonb_build_object(
    'card', (
      select jsonb_build_object(
               'id', c.id,
               'number', c.number,
               'title', c.title,
               'state', c.state,
               'state_reason', (
                 select e.reason
                   from public.card_events e
                  where e.card_id = c.id
                    and e.type in ('moved', 'archived')
                  order by e.seq desc
                  limit 1),
               'blocked_by', private.card_blocked_by(c.id),
               'above', private.card_above(c.id),
               'links_assessed', private.card_links_assessed(c.id))
        from public.cards c
       where c.id = (select o.card_id from offer o)),
    'last', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'type', l.type,
               'from_state', l.from_state,
               'to_state', l.to_state,
               'text', l.said,
               'created_at', l.created_at)
             order by l.created_at desc, l.seq desc), '[]'::jsonb)
        from (
          select w.*
            from work w
           where w.card_id = (select o.card_id from offer o)
           order by w.created_at desc, w.seq desc
           limit 2
        ) l),
    'last_session', (
      select case
               when n.card_id is distinct from (select o.card_id from offer o)
               then jsonb_build_object('number', c.number, 'title', c.title,
                                       'type', n.type, 'to_state', n.to_state)
             end
        from newest n
        join public.cards c on c.id = n.card_id),
    'thread', p_thread)
  end
$$;

revoke all on function private.continuation_horizon_days() from public, anon;
revoke all on function private.card_own_work(text) from public, anon;
grant execute on function private.continuation_horizon_days()
  to authenticated, service_role;
grant execute on function private.card_own_work(text)
  to authenticated, service_role;
