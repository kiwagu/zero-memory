-- Migration: a new session is offered where it left off
--
-- Purpose:
--   A briefing names the card its caller worked on last, when the calling
--   conversation is bound to none — the card a new session, on any device,
--   picks up. Only the caller's own work counts, never the calling
--   conversation's; what the release hook writes (the release record, and
--   the move that closes a card with it) is not work; nothing older than the
--   horizon shows. The briefing only offers: binding stays the agent's step.
--
-- Affected objects:
--   - function private.card_continuation (new)
--   - function public.briefing_work: + `continuation`, and a project whose
--     only news is the caller's last step still briefs
--
-- Special considerations:
--   - SECURITY INVOKER: the caller's RLS decides which cards exist for them.
--   - The horizon is the `zm.continuation_horizon_days` setting, 30 days by
--     default, like the other briefing knobs.

set search_path = public, extensions;

create or replace function private.card_continuation(
  p_scope text,
  p_thread text
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with knobs as (
    select coalesce(
             nullif(current_setting('zm.continuation_horizon_days', true), '')::integer,
             30) as horizon_days
  ),
  work as (
    select e.card_id, e.seq, e.type, e.from_state, e.to_state,
           coalesce(e.reason, e.note_text) as said, e.created_at
      from public.card_events e
      join public.cards c on c.id = e.card_id
     cross join knobs k
     where e.scope operator(extensions.=) p_scope::extensions.ltree
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
       and (p_thread is null or e.thread is distinct from p_thread)
       and e.created_at > now() - make_interval(days => k.horizon_days)
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
               'text', case
                         when l.said is null then null
                         when length(l.said) > 120 then left(l.said, 119) || '…'
                         else l.said
                       end,
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

comment on function private.card_continuation(text, text) is
  'The card a new session is offered to continue: the caller''s own latest '
  'work on this board, never the calling conversation''s, still active and '
  'within the horizon, with the caller''s last step when it was on another '
  'card.';

revoke all on function private.card_continuation(text, text) from public, anon;
grant execute on function private.card_continuation(text, text)
  to authenticated, service_role;

create or replace function public.briefing_work(
  p_scope text,
  p_thread text default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_bound jsonb;
  v_bound_id text;
  v_active integer;
  v_waiting integer;
  v_lead jsonb;
  v_named text[];
  v_loops jsonb;
  v_open jsonb;
  v_cont jsonb;
begin
  if p_thread is not null then
    select c.id,
           jsonb_build_object(
             'id', c.id,
             'number', c.number,
             'title', c.title,
             'state', c.state,
             -- WHY it sits in its column, as the board tile shows it.
             'state_reason', (
               select e.reason
                 from public.card_events e
                where e.card_id = c.id
                  and e.type in ('moved', 'archived')
                order by e.seq desc
                limit 1),
             'refs', (select count(*) from public.card_refs r
                       where r.card_id = c.id),
             -- The latest production state that carried the card.
             'released_in', (
               select e.release_version from public.card_events e
                where e.card_id = c.id and e.type = 'released'
                order by e.seq desc limit 1),
             'updated_at', c.updated_at,
             -- What holds it, what sits above it, and whether anyone ever
             -- said how it relates to the board.
             'blocked_by', private.card_blocked_by(c.id),
             'above', private.card_above(c.id),
             'links_assessed', private.card_links_assessed(c.id)
           )
      into v_bound_id, v_bound
      from public.cards c
     where c.scope operator(extensions.=) p_scope::extensions.ltree
       and c.archived_at is null
       and exists (
             select 1
               from public.card_refs r
              where r.card_id = c.id
                and r.kind = 'thread'
                and r.target = p_thread
           )
     order by c.updated_at desc
     limit 1;
  end if;

  select count(*) filter (where c.state = 'active'),
         count(*) filter (where c.state = 'waiting')
    into v_active, v_waiting
    from public.cards c
   where c.scope operator(extensions.=) p_scope::extensions.ltree
     and c.archived_at is null;

  -- Branches still open on live cards, freshest card first: the briefing
  -- names them next to their card, and the client checks them against git.
  -- Each carries the squashes of that branch the board already recorded, on
  -- any card: a branch reopened for more work has its old squash on main,
  -- and that one is not a landing nobody recorded.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'card_id', ob.card_id,
             'number', ob.number,
             'state', ob.state,
             'repo', ob.repo,
             'branch', ob.branch,
             'landings', (
               select coalesce(jsonb_agg(
                        jsonb_build_object('squash_sha', l.squash_sha)
                        order by l.first_at
                      ), '[]'::jsonb)
                 from (
                   select e.squash_sha, min(e.created_at) as first_at
                     from public.card_events e
                    where e.scope operator(extensions.=) p_scope::extensions.ltree
                      and e.type = 'landed'
                      and e.ref_target = ob.repo || ':' || ob.branch
                      and e.squash_sha is not null
                    group by e.squash_sha
                 ) l
             ))
           order by ob.updated_at desc, ob.attached_at),
         '[]'::jsonb)
    into v_open
    from (
      select b.card_id, c.number, c.state, b.repo, b.branch,
             c.updated_at, b.attached_at
        from public.card_branches b
        join public.cards c on c.id = b.card_id
       where b.scope operator(extensions.=) p_scope::extensions.ltree
         and b.state = 'open'
         and c.archived_at is null
       order by c.updated_at desc, b.attached_at
       limit 20
    ) ob;

  -- Where a new session left off, when this conversation is bound to none.
  if v_bound is null then
    v_cont := private.card_continuation(p_scope, p_thread);
  end if;

  -- A project with no work in flight but a known production state still
  -- briefs, so the production line is not lost with the work; so does one
  -- whose only news is where the caller left off.
  if v_bound is null and v_active + v_waiting = 0
     and v_open = '[]'::jsonb
     and v_cont is null
     and not exists (select 1 from public.scope_releases r
                      where r.scope operator(extensions.=) p_scope::extensions.ltree) then
    return null;
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', lead.id,
               'number', lead.number,
               'title', lead.title,
               'state', lead.state,
               'released_in', (
                 select e.release_version from public.card_events e
                  where e.card_id = lead.id and e.type = 'released'
                  order by e.seq desc limit 1),
               'blocked_by', private.card_blocked_by(lead.id),
               'links_assessed', private.card_links_assessed(lead.id))
             order by lead.updated_at desc),
           '[]'::jsonb),
         coalesce(array_agg(lead.id), '{}')
    into v_lead, v_named
    from (
      select c.id, c.number, c.title, c.state, c.updated_at
        from public.cards c
       where c.scope operator(extensions.=) p_scope::extensions.ltree
         and c.archived_at is null
         and c.state in ('active', 'waiting')
         and c.id is distinct from v_bound_id
       order by c.updated_at desc
       limit 3
    ) lead;

  if v_bound_id is not null then
    v_named := v_named || v_bound_id;
  end if;

  -- The loops a named card carries: the ones attached to it, and the one it
  -- was promoted from. Either way the briefing shows them through the card.
  select coalesce(jsonb_agg(distinct carried.id), '[]'::jsonb)
    into v_loops
    from (
      select r.target as id
        from public.card_refs r
       where r.card_id = any (v_named)
         and r.kind = 'memory'
      union
      select c.origin_loop_id
        from public.cards c
       where c.id = any (v_named)
         and c.origin_loop_id is not null
    ) carried
    join public.memories m on m.id = carried.id
   where m.kind in ('task', 'open-question')
     and m.invalidated_at is null;

  return jsonb_build_object(
    'bound_card', v_bound,
    'active', v_active,
    'waiting', v_waiting,
    'lead', v_lead,
    'attached_loop_ids', v_loops,
    -- The production state seen most recently: after a rollback that is
    -- the earlier version again.
    'production', (
      select jsonb_build_object('version', r.version, 'build', r.build,
                                'observed_at', r.last_observed_at)
        from public.scope_releases r
       where r.scope operator(extensions.=) p_scope::extensions.ltree
       order by r.last_observed_at desc, r.observed_at desc, r.version desc
       limit 1),
    'open_branches', v_open,
    -- The card a new session is offered to continue; null when this
    -- conversation is bound or the caller has no recent work here.
    'continuation', v_cont
  );
end;
$$;
