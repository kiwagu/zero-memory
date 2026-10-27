-- Migration: the work summary a briefing carries
--
-- Purpose:
--   A session opens on its project's briefing, and the project board is where
--   the project's ongoing work lives, so the briefing names it: the card this
--   conversation is bound to (why it sits in its column, how much hangs on
--   it), how many cards are active and waiting, and the first few of them.
--   The open loops attached to a card the summary names come back too, so the
--   briefing shows them through their card rather than a second time on their
--   own.
--
-- Affected objects:
--   - function: public.briefing_work (new)
--
-- Special considerations:
--   - SECURITY INVOKER, like every board read: the caller's own RLS decides
--     which cards and memories exist for them.
--   - Returns null when there is nothing to say — no bound card and no active
--     or waiting card — so a project without board work briefs exactly as it
--     did before, with no summary and nothing displaced for one.
--   - A loop is reported as attached only when its card is one the summary
--     NAMES (the bound card or a lead card). A loop hanging on a card the
--     briefing does not mention must keep arriving as a loop, or it would
--     vanish from the briefing altogether.
--   - Bounded output: one bound card, at most three lead cards, one reason.

set search_path = public, extensions;

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
             'updated_at', c.updated_at
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

  if v_bound is null and v_active + v_waiting = 0 then
    return null;
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', lead.id,
               'number', lead.number,
               'title', lead.title,
               'state', lead.state)
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

  select coalesce(jsonb_agg(distinct r.target), '[]'::jsonb)
    into v_loops
    from public.card_refs r
    join public.memories m on m.id = r.target
   where r.card_id = any (v_named)
     and r.kind = 'memory'
     and m.kind in ('task', 'open-question')
     and m.invalidated_at is null;

  return jsonb_build_object(
    'bound_card', v_bound,
    'active', v_active,
    'waiting', v_waiting,
    'lead', v_lead,
    'attached_loop_ids', v_loops
  );
end;
$$;

comment on function public.briefing_work(text, text) is
  'The work summary of a project briefing: the card bound to the calling '
  'conversation, active/waiting counts, the first three other active or '
  'waiting cards, and the open loops attached to the cards it names. Null '
  'when the project has no such work.';

revoke all on function public.briefing_work(text, text) from public, anon;
grant execute on function public.briefing_work(text, text)
  to authenticated, service_role;
