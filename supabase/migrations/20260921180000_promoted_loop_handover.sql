-- Migration: a loop promoted to a card is the card's to settle
--
-- Purpose:
--   `promote_loop` hands an open loop's work over to a card and leaves the
--   loop itself alone. From then on the CARD is where that work's state lives.
--   Three places still treated such a loop as free-standing, and this
--   migration settles each of them:
--
--   1. The loop-closure judge could still close it. Closing means "finished",
--      but a promoted loop was handed over, not finished, so the judge's
--      candidate query now skips any loop that has a card.
--   2. The briefing kept listing it as an open loop, on top of the card that
--      carries it. A card the briefing names now brings its origin loop with it,
--      exactly as it already does for loops attached to that card; a loop whose
--      card is not named still arrives as a loop, so it never vanishes.
--   3. Two concurrent promotions of the same loop could both pass the
--      "already promoted" check and the second failed on the unique index as
--      an internal error. The check now runs under the scope's lock, so the
--      second caller gets `already_promoted` together with the card that
--      exists. The refusal also names that card, so the caller can go to it.
--   4. A card's origin must be a loop the caller can read. The pointer now also
--      keeps that loop away from the closure judge and from hygiene, so a card
--      must not be able to point at a memory its author cannot see.
--
-- Affected objects:
--   - function: public.find_loop_closure_evidence (replaced, same signature)
--   - function: public.briefing_work (replaced, same signature)
--   - function: public.card_create (replaced, same signature)
--
-- Special considerations:
--   - `create or replace` keeps each function's grants and comment.
--   - An archived card still counts: its loop was handed over, and archiving
--     the card is a decision about the card, not a verdict on the loop.

set search_path = public, extensions;

-- 1. the loop-closure judge skips promoted loops ------------------------------

create or replace function public.find_loop_closure_evidence(
  p_owner text default null,
  p_min_similarity double precision default 0.60,
  p_max_evidence integer default 3
)
returns table (
  loop_id text,
  owner_id text,
  evidence_ids text[],
  newest_evidence_id text,
  top_similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with loops as (
    select m.id, m.owner_id, m.embedding, m.created_at
    from public.memories m
    where m.kind in ('task', 'open-question')
      and m.invalidated_at is null
      and m.embedding is not null
      and (p_owner is null or m.owner_id = p_owner)
      -- A loop handed over to a card is not the judge's to close: the card
      -- now carries that work, and "closed" would read as "finished".
      and not exists (
        select 1 from public.cards c where c.origin_loop_id = m.id
      )
  ),
  evidence as (
    select
      l.id as loop_id,
      l.owner_id,
      e.id as evidence_id,
      e.created_at,
      1 - (e.embedding operator(extensions.<=>) l.embedding) as similarity
    from loops l
    join public.memories e
      on e.owner_id = l.owner_id
      and e.created_at > l.created_at
      and e.invalidated_at is null
      and e.embedding is not null
      -- A loop never closes a loop: narrowed follow-up tasks stay evidence-
      -- free; only substantive memories (facts, decisions, ...) qualify.
      and e.kind not in ('task', 'open-question')
    where 1 - (e.embedding operator(extensions.<=>) l.embedding)
      >= p_min_similarity
  ),
  ranked as (
    select
      evidence.*,
      row_number() over (
        partition by evidence.loop_id
        order by evidence.similarity desc, evidence.created_at desc
      ) as sim_rank
    from evidence
  )
  select
    r.loop_id,
    r.owner_id,
    -- Judge input: the strongest N matches…
    array_agg(r.evidence_id order by r.similarity desc)
      filter (where r.sim_rank <= greatest(p_max_evidence, 1))
      as evidence_ids,
    -- …but the re-judge guard keys on the newest match overall, so a fresh
    -- weak match still counts as "new information arrived".
    (array_agg(r.evidence_id order by r.created_at desc, r.evidence_id))[1]
      as newest_evidence_id,
    max(r.similarity) as top_similarity
  from ranked r
  group by r.loop_id, r.owner_id;
$$;

-- 2. a named card brings its origin loop into the briefing --------------------

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
    'attached_loop_ids', v_loops
  );
end;
$$;

-- 3. promotion checks run under the scope lock, and name the existing card ---

create or replace function public.card_create(
  p_scope text,
  p_title text,
  p_body text default '',
  p_state text default 'idea',
  p_origin_loop_id text default null,
  p_thread text default null,
  p_agent_label text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_card public.cards;
  v_number integer;
begin
  -- Serialize creation within the scope: two concurrent creates must not read
  -- the same max number, and two concurrent promotions of one loop must not
  -- both pass the "already promoted" check below. The lock is transaction-
  -- scoped and scope-local; a promoted loop's card lives in the loop's scope.
  perform pg_advisory_xact_lock(hashtext(p_scope));

  if p_idempotency_key is not null then
    select * into v_card from public.cards
      where scope operator(extensions.=) p_scope::extensions.ltree
        and idempotency_key = p_idempotency_key;
    if found then
      -- The first call already landed; hand back what it made.
      return jsonb_build_object('card', private.card_json(v_card),
                                'replayed', true);
    end if;
  end if;

  if p_origin_loop_id is not null then
    -- The origin must be a loop the caller can read (RLS decides): the foreign
    -- key alone would accept any memory id, readable or not.
    perform 1 from public.memories m
      where m.id = p_origin_loop_id
        and m.kind in ('task', 'open-question');
    if not found then
      return jsonb_build_object('error', 'not_found');
    end if;

    select * into v_card from public.cards
      where origin_loop_id = p_origin_loop_id;
    if found then
      return jsonb_build_object(
        'error', 'already_promoted',
        'message', format('That loop already has a card: #%s "%s" (%s).',
                          v_card.number, v_card.title, v_card.id),
        'card', private.card_json(v_card));
    end if;
  end if;

  select coalesce(max(number), 0) + 1 into v_number
    from public.cards
   where scope operator(extensions.=) p_scope::extensions.ltree;

  insert into public.cards
    (scope, number, title, body, state, origin_loop_id, idempotency_key)
  values
    (p_scope::extensions.ltree, v_number, btrim(p_title), coalesce(p_body, ''),
     coalesce(p_state, 'idea'), p_origin_loop_id, p_idempotency_key)
  returning * into v_card;

  insert into public.card_events
    (card_id, scope, seq, type, agent_label, thread, to_state)
  values
    (v_card.id, v_card.scope, 1, 'created', p_agent_label, p_thread,
     v_card.state);

  return jsonb_build_object('card', private.card_json(v_card),
                            'replayed', false);
end;
$$;
