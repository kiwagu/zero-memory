-- Migration: board commands and reads
--
-- Purpose:
--   The atomic half of the board. Allocating a card's project-local number and
--   a stream position are both read-modify-write races, and a retried call
--   after a network timeout must land once — none of that can live in an
--   application that may be one of several talking to the same card.
--
-- Affected objects:
--   - function: public.card_create, public.card_promote_loop
--   - function: public.card_edit, public.card_move, public.card_archive
--   - function: public.card_attach, public.card_detach, public.card_note
--   - function: public.card_get, public.board_list, public.card_resolve
--
-- Special considerations:
--   - SECURITY INVOKER throughout, so every statement inside meets the same RLS
--     fence as a direct call. Authorization is never re-implemented here.
--   - Failures RETURN rather than raise: `{"error": "<code>"}` with nothing
--     written. Codes are `not_found`, `archived`, `same_state`, `conflict`,
--     `not_attached`, `already_promoted` and `invalid`.
--   - These functions are the ENFORCING copy of the card invariants. The domain
--     package holds a fast, unit-tested copy of the same rules; a drift test
--     asserts the two refuse the same things, because a direct PostgREST call
--     meets only this one.
--   - Every mutation takes the card's row lock first, so a card's stream
--     positions are handed out in order even under concurrent writers.

set search_path = public, extensions;

-- 1. helpers ------------------------------------------------------------------

-- One card, as every read returns it.
create or replace function private.card_json(p_card public.cards)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_card.id,
    'scope', p_card.scope::text,
    'number', p_card.number,
    'title', p_card.title,
    'body', p_card.body,
    'state', p_card.state,
    'revision', p_card.revision,
    'origin_loop_id', p_card.origin_loop_id,
    'created_by', p_card.created_by,
    'created_at', p_card.created_at,
    'updated_at', p_card.updated_at,
    'archived_at', p_card.archived_at
  );
$$;

comment on function private.card_json(public.cards) is
  'Render one card row for a tool result. One place, so every read agrees.';

-- 2. create -------------------------------------------------------------------

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
    select * into v_card from public.cards
      where origin_loop_id = p_origin_loop_id;
    if found then
      return jsonb_build_object('error', 'already_promoted',
                                'card', private.card_json(v_card));
    end if;
  end if;

  -- Serialize number allocation within the scope: two concurrent creates must
  -- not read the same max. The lock is transaction-scoped and scope-local.
  perform pg_advisory_xact_lock(hashtext(p_scope));

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

comment on function public.card_create(
  text, text, text, text, text, text, text, text) is
  'Open a card: allocate the next project-local number in the scope and write '
  'its first event. An archived card keeps its number, so numbers are never '
  'handed out twice.';

-- Promoting an open loop is card_create with the loop recorded as the card''s
-- origin. It deliberately does NOT touch the loop: closing it would erase the
-- difference between work that was handed over and work that was finished, and
-- memory hygiene must never be able to close a card through the loop it came
-- from.
create or replace function public.card_promote_loop(
  p_loop_id text,
  p_title text,
  p_body text default '',
  p_state text default 'active',
  p_thread text default null,
  p_agent_label text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_scope extensions.ltree;
  v_kind text;
begin
  select scope, kind into v_scope, v_kind
    from public.memories where id = p_loop_id and invalidated_at is null;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_kind not in ('task', 'open-question') then
    return jsonb_build_object('error', 'invalid',
                              'message', 'Only an open loop promotes to a card.');
  end if;

  return public.card_create(
    v_scope::text, p_title, p_body, p_state, p_loop_id, p_thread,
    p_agent_label, p_idempotency_key);
end;
$$;

comment on function public.card_promote_loop(
  text, text, text, text, text, text, text) is
  'Promote an open loop into a card, recording where the work came from. The '
  'loop itself is untouched: it was handed over, not finished.';

-- 3. mutations ----------------------------------------------------------------

create or replace function public.card_move(
  p_card_id text,
  p_to_state text,
  p_reason text,
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
  v_from text;
  v_seq bigint;
begin
  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('error', 'invalid',
                              'message', 'A move must carry a reason.');
  end if;

  if p_idempotency_key is not null
     and exists (select 1 from public.card_events
                  where card_id = p_card_id
                    and idempotency_key = p_idempotency_key) then
    select * into v_card from public.cards where id = p_card_id;
    return jsonb_build_object('card', private.card_json(v_card),
                              'replayed', true);
  end if;

  -- Two reads, so the answer is honest: a card the caller cannot SEE is
  -- `not_found`, while one they can see but may not write is `forbidden`.
  -- `for update` additionally requires the update policy, so the lock alone
  -- would report a reader's lack of rights as a missing card.
  if not exists (select 1 from public.cards where id = p_card_id) then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into v_card from public.cards where id = p_card_id for update;
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_card.archived_at is not null then
    return jsonb_build_object('error', 'archived');
  end if;
  if v_card.state = p_to_state then
    return jsonb_build_object('error', 'same_state', 'state', v_card.state);
  end if;

  v_from := v_card.state;
  update public.cards
     set state = p_to_state, updated_at = now()
   where id = p_card_id
  returning * into v_card;

  select coalesce(max(seq), 0) + 1 into v_seq
    from public.card_events where card_id = p_card_id;

  insert into public.card_events
    (card_id, scope, seq, type, agent_label, thread,
     from_state, to_state, reason, idempotency_key)
  values
    (p_card_id, v_card.scope, v_seq, 'moved', p_agent_label, p_thread,
     v_from, p_to_state, btrim(p_reason), p_idempotency_key);

  return jsonb_build_object('card', private.card_json(v_card),
                            'replayed', false);
end;
$$;

comment on function public.card_move(text, text, text, text, text, text) is
  'Declare where the work now stands. The reason is the point of the call: it '
  'is what the next reader has instead of reconstructing why the column moved.';

create or replace function public.card_edit(
  p_card_id text,
  p_title text default null,
  p_body text default null,
  p_expected_revision integer default null,
  p_thread text default null,
  p_agent_label text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_card public.cards;
  v_title text;
  v_body text;
  v_seq bigint;
begin
  -- Two reads, so the answer is honest: a card the caller cannot SEE is
  -- `not_found`, while one they can see but may not write is `forbidden`.
  -- `for update` additionally requires the update policy, so the lock alone
  -- would report a reader's lack of rights as a missing card.
  if not exists (select 1 from public.cards where id = p_card_id) then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into v_card from public.cards where id = p_card_id for update;
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_card.archived_at is not null then
    return jsonb_build_object('error', 'archived');
  end if;
  if p_expected_revision is not null
     and p_expected_revision <> v_card.revision then
    return jsonb_build_object('error', 'conflict', 'revision', v_card.revision);
  end if;

  v_title := coalesce(btrim(p_title), v_card.title);
  v_body := coalesce(p_body, v_card.body);
  if v_title = v_card.title and v_body = v_card.body then
    -- Nothing changed: no revision, no event. A stream of empty edits would
    -- bury the moves that matter.
    return jsonb_build_object('card', private.card_json(v_card),
                              'changed', false);
  end if;

  update public.cards
     set title = v_title, body = v_body,
         revision = v_card.revision + 1, updated_at = now()
   where id = p_card_id
  returning * into v_card;

  select coalesce(max(seq), 0) + 1 into v_seq
    from public.card_events where card_id = p_card_id;

  insert into public.card_events
    (card_id, scope, seq, type, agent_label, thread, revision)
  values
    (p_card_id, v_card.scope, v_seq, 'edited', p_agent_label, p_thread,
     v_card.revision);

  return jsonb_build_object('card', private.card_json(v_card),
                            'changed', true);
end;
$$;

comment on function public.card_edit(text, text, text, integer, text, text) is
  'Rewrite a card''s text. An edit naming an older revision is refused so two '
  'writers cannot silently overwrite each other.';

create or replace function public.card_archive(
  p_card_id text,
  p_reason text,
  p_thread text default null,
  p_agent_label text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_card public.cards;
  v_seq bigint;
begin
  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('error', 'invalid',
                              'message', 'Archiving must carry a reason.');
  end if;

  -- Two reads, so the answer is honest: a card the caller cannot SEE is
  -- `not_found`, while one they can see but may not write is `forbidden`.
  -- `for update` additionally requires the update policy, so the lock alone
  -- would report a reader's lack of rights as a missing card.
  if not exists (select 1 from public.cards where id = p_card_id) then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into v_card from public.cards where id = p_card_id for update;
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_card.archived_at is not null then
    return jsonb_build_object('error', 'archived');
  end if;

  update public.cards
     set archived_at = now(), updated_at = now()
   where id = p_card_id
  returning * into v_card;

  select coalesce(max(seq), 0) + 1 into v_seq
    from public.card_events where card_id = p_card_id;

  insert into public.card_events
    (card_id, scope, seq, type, agent_label, thread, reason)
  values
    (p_card_id, v_card.scope, v_seq, 'archived', p_agent_label, p_thread,
     btrim(p_reason));

  return jsonb_build_object('card', private.card_json(v_card));
end;
$$;

comment on function public.card_archive(text, text, text, text) is
  'Take a card off the board. Terminal — an archived card is read-only, and '
  'its number stays spent. Reversible shelving is the `parked` state.';

create or replace function public.card_attach(
  p_card_id text,
  p_kind text,
  p_target text,
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
  v_seq bigint;
begin
  -- Two reads, so the answer is honest: a card the caller cannot SEE is
  -- `not_found`, while one they can see but may not write is `forbidden`.
  -- `for update` additionally requires the update policy, so the lock alone
  -- would report a reader's lack of rights as a missing card.
  if not exists (select 1 from public.cards where id = p_card_id) then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into v_card from public.cards where id = p_card_id for update;
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_card.archived_at is not null then
    return jsonb_build_object('error', 'archived');
  end if;
  if p_kind = 'card' and p_target = p_card_id then
    return jsonb_build_object('error', 'invalid',
                              'message', 'A card cannot reference itself.');
  end if;

  if exists (select 1 from public.card_refs
              where card_id = p_card_id and kind = p_kind
                and target = p_target) then
    -- Already attached: one target, one attachment, whoever asks again.
    return jsonb_build_object('card', private.card_json(v_card),
                              'changed', false);
  end if;

  insert into public.card_refs (card_id, scope, kind, target)
  values (p_card_id, v_card.scope, p_kind, p_target);

  select coalesce(max(seq), 0) + 1 into v_seq
    from public.card_events where card_id = p_card_id;

  insert into public.card_events
    (card_id, scope, seq, type, agent_label, thread,
     ref_kind, ref_target, idempotency_key)
  values
    (p_card_id, v_card.scope, v_seq, 'attached', p_agent_label, p_thread,
     p_kind, p_target, p_idempotency_key);

  return jsonb_build_object('card', private.card_json(v_card),
                            'changed', true);
end;
$$;

comment on function public.card_attach(
  text, text, text, text, text, text) is
  'Point a card at an artifact. Attaching changes nothing about the target, '
  'and attaching the same one twice leaves one attachment.';

create or replace function public.card_detach(
  p_card_id text,
  p_kind text,
  p_target text,
  p_thread text default null,
  p_agent_label text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_card public.cards;
  v_seq bigint;
begin
  -- Two reads, so the answer is honest: a card the caller cannot SEE is
  -- `not_found`, while one they can see but may not write is `forbidden`.
  -- `for update` additionally requires the update policy, so the lock alone
  -- would report a reader's lack of rights as a missing card.
  if not exists (select 1 from public.cards where id = p_card_id) then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into v_card from public.cards where id = p_card_id for update;
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_card.archived_at is not null then
    return jsonb_build_object('error', 'archived');
  end if;

  delete from public.card_refs
   where card_id = p_card_id and kind = p_kind and target = p_target;
  if not found then
    return jsonb_build_object('error', 'not_attached');
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
    from public.card_events where card_id = p_card_id;

  insert into public.card_events
    (card_id, scope, seq, type, agent_label, thread, ref_kind, ref_target)
  values
    (p_card_id, v_card.scope, v_seq, 'detached', p_agent_label, p_thread,
     p_kind, p_target);

  return jsonb_build_object('card', private.card_json(v_card));
end;
$$;

comment on function public.card_detach(text, text, text, text, text) is
  'Remove an attachment. The stream keeps both the attach and the detach, so '
  'the history of the link survives the link.';

create or replace function public.card_note(
  p_card_id text,
  p_text text,
  p_reply_to text default null,
  p_relation text default null,
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
  v_seq bigint;
  v_id text;
begin
  if p_text is null or btrim(p_text) = '' then
    return jsonb_build_object('error', 'invalid',
                              'message', 'A note must not be empty.');
  end if;
  if p_relation is not null and p_reply_to is null then
    return jsonb_build_object(
      'error', 'invalid',
      'message', 'A relation needs the note it answers: pass reply_to.');
  end if;

  if p_idempotency_key is not null
     and exists (select 1 from public.card_events
                  where card_id = p_card_id
                    and idempotency_key = p_idempotency_key) then
    return jsonb_build_object('replayed', true);
  end if;

  -- Two reads, so the answer is honest: a card the caller cannot SEE is
  -- `not_found`, while one they can see but may not write is `forbidden`.
  -- `for update` additionally requires the update policy, so the lock alone
  -- would report a reader's lack of rights as a missing card.
  if not exists (select 1 from public.cards where id = p_card_id) then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into v_card from public.cards where id = p_card_id for update;
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_card.archived_at is not null then
    return jsonb_build_object('error', 'archived');
  end if;
  if p_reply_to is not null
     and not exists (select 1 from public.card_events
                      where id = p_reply_to and card_id = p_card_id) then
    return jsonb_build_object('error', 'not_found',
                              'message', 'No such note on this card.');
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
    from public.card_events where card_id = p_card_id;

  insert into public.card_events
    (card_id, scope, seq, type, agent_label, thread,
     note_text, reply_to, relation, idempotency_key)
  values
    (p_card_id, v_card.scope, v_seq, 'noted', p_agent_label, p_thread,
     btrim(p_text), p_reply_to, p_relation, p_idempotency_key)
  returning id into v_id;

  return jsonb_build_object('event_id', v_id, 'seq', v_seq, 'replayed', false);
end;
$$;

comment on function public.card_note(
  text, text, text, text, text, text, text) is
  'Add an author''s statement to a card. A note is a claim, not a verdict: '
  'text saying the work is finished does not move the card.';

-- 4. reads --------------------------------------------------------------------

-- One card with its attachments and a page of its stream.
--
-- Attachments carry a PREVIEW only when the caller may read the target. The
-- joins run under the caller's own RLS, so an invisible memory or entity comes
-- back as an id-only stub with `available: false` — the card stays legible
-- without leaking a line of what the viewer has no right to see.
create or replace function public.card_get(
  p_card_id text,
  p_after_seq bigint default 0,
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
  v_refs jsonb;
  v_events jsonb;
  v_remaining integer;
begin
  select * into v_card from public.cards where id = p_card_id;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'kind', r.kind,
             'target', r.target,
             'attached_at', r.attached_at,
             'available', r.preview is not null or r.kind in ('url', 'thread'),
             'preview', r.preview
           ) order by r.attached_at
         ), '[]'::jsonb)
    into v_refs
    from (
      select cr.kind, cr.target, cr.attached_at,
             case cr.kind
               when 'memory' then left(m.content, 200)
               when 'entity' then e.name
               when 'card' then c.title
               else null
             end as preview
        from public.card_refs cr
        left join public.memories m
          on cr.kind = 'memory' and m.id = cr.target
        left join public.entities e
          on cr.kind = 'entity' and e.id = cr.target
        left join public.cards c
          on cr.kind = 'card' and c.id = cr.target
       where cr.card_id = p_card_id
    ) r;

  select coalesce(jsonb_agg(ev order by ev.seq), '[]'::jsonb)
    into v_events
    from (
      select jsonb_build_object(
               'id', id,
               'seq', seq,
               'type', type,
               'actor_id', actor_id,
               'agent_label', agent_label,
               'thread', thread,
               'from_state', from_state,
               'to_state', to_state,
               'reason', reason,
               'revision', revision,
               'text', note_text,
               'reply_to', reply_to,
               'relation', relation,
               'ref_kind', ref_kind,
               'ref_target', ref_target,
               'created_at', created_at
             ) as ev, seq
        from public.card_events
       where card_id = p_card_id and seq > coalesce(p_after_seq, 0)
       order by seq
       limit v_limit
    ) ev;

  select count(*) into v_remaining
    from public.card_events
   where card_id = p_card_id and seq > coalesce(p_after_seq, 0);

  return jsonb_build_object(
    'card', private.card_json(v_card),
    'refs', v_refs,
    'events', v_events,
    'has_more', v_remaining > v_limit,
    'next_after_seq', coalesce(
      (select max((e->>'seq')::bigint) from jsonb_array_elements(v_events) e),
      coalesce(p_after_seq, 0))
  );
end;
$$;

comment on function public.card_get(text, bigint, integer) is
  'One card, its attachments and a page of its stream after a cursor. A '
  'target the caller may not read comes back as an id-only stub.';

-- The board: cards of a scope, newest activity first.
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
                  limit 1)
             ) as row,
             c.updated_at
        from public.cards c
       where (p_scope is null
              or c.scope operator(extensions.=) p_scope::extensions.ltree)
         and (p_state is null or c.state = p_state)
         and (p_include_archived or c.archived_at is null)
         and (p_query is null or btrim(p_query) = ''
              or c.title ilike '%' || btrim(p_query) || '%')
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

comment on function public.board_list(
  text, text, text, boolean, integer) is
  'The board of a scope: cards with their last event, plus live totals per '
  'state. A title query returns candidates — it never picks one silently.';

-- Resolve a project-local address (`#42`) inside one scope.
create or replace function public.card_resolve(
  p_scope text,
  p_number integer
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_card public.cards;
begin
  select * into v_card from public.cards
    where scope operator(extensions.=) p_scope::extensions.ltree
      and number = p_number;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('card', private.card_json(v_card));
end;
$$;

comment on function public.card_resolve(text, integer) is
  'A short address resolves only inside a named scope: `#42` means nothing '
  'without one, and the same number in another project is another card.';

-- 5. grants -------------------------------------------------------------------

-- Security invoker throughout, so the caller''s own RLS decides every row.
-- anon gets nothing.
revoke all on function public.card_create(
  text, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.card_promote_loop(
  text, text, text, text, text, text, text) from public, anon;
revoke all on function public.card_move(
  text, text, text, text, text, text) from public, anon;
revoke all on function public.card_edit(
  text, text, text, integer, text, text) from public, anon;
revoke all on function public.card_archive(
  text, text, text, text) from public, anon;
revoke all on function public.card_attach(
  text, text, text, text, text, text) from public, anon;
revoke all on function public.card_detach(
  text, text, text, text, text) from public, anon;
revoke all on function public.card_note(
  text, text, text, text, text, text, text) from public, anon;
revoke all on function public.card_get(text, bigint, integer) from public, anon;
revoke all on function public.board_list(
  text, text, text, boolean, integer) from public, anon;
revoke all on function public.card_resolve(text, integer) from public, anon;
revoke all on function private.card_json(public.cards) from public, anon;

grant execute on function public.card_create(
  text, text, text, text, text, text, text, text) to authenticated, service_role;
grant execute on function public.card_promote_loop(
  text, text, text, text, text, text, text) to authenticated, service_role;
grant execute on function public.card_move(
  text, text, text, text, text, text) to authenticated, service_role;
grant execute on function public.card_edit(
  text, text, text, integer, text, text) to authenticated, service_role;
grant execute on function public.card_archive(
  text, text, text, text) to authenticated, service_role;
grant execute on function public.card_attach(
  text, text, text, text, text, text) to authenticated, service_role;
grant execute on function public.card_detach(
  text, text, text, text, text) to authenticated, service_role;
grant execute on function public.card_note(
  text, text, text, text, text, text, text) to authenticated, service_role;
grant execute on function public.card_get(text, bigint, integer)
  to authenticated, service_role;
grant execute on function public.board_list(
  text, text, text, boolean, integer) to authenticated, service_role;
grant execute on function public.card_resolve(text, integer)
  to authenticated, service_role;
grant execute on function private.card_json(public.cards)
  to authenticated, service_role;
