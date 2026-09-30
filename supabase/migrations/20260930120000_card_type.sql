-- Migration: a card declares why its work exists
--
-- Purpose:
--   A card carries a type in the vocabulary most boards already use: story (a
--   feature from the user's side, a person's or an agent's), bug (a product
--   function is broken), task (neither: docs, tests, refactoring, ops) or spike
--   (the output is an answer, not a change). Like the state and the severity,
--   it is a DECLARATION for readers: nothing here sorts, gates or dispatches
--   by it, and the board keeps its one order, the last change.
--
--   Every new card declares one, so the store refuses a card without it.
--   Cards written before this migration keep a null type, "not declared": no
--   row is rewritten, because which type each existing card has is a judgement
--   about that card, not something a schema change can know. Such a card
--   declares its type when it is picked up, on its way into active.
--
-- Affected objects:
--   - table public.cards: + type (text, one of the four, null only on cards
--     that predate it)
--   - table public.card_events: + from_card_type, to_card_type — the types an
--     `edited` row changed between, or a `moved` row declared
--   - function private.card_type_refusal (new): the refusal of a type the
--     vocabulary does not have, shared by every command that takes one
--   - function private.card_json: + type
--   - function public.card_create, public.card_promote_loop: + p_type, refused
--     with type_required when missing (dropped and recreated)
--   - function public.card_edit: + p_type (dropped and recreated); a change
--     bumps the revision and records both types on the edit event
--   - function public.card_move: + p_type (dropped and recreated); entering
--     active with no type declared is refused with type_required, and a type
--     on a move only declares a card that has none
--   - function public.board_list: each row + type (replaced in place)
--   - function public.card_get: each event + from_card_type, to_card_type
--   - function public.briefing_work, private.card_continuation: each card
--     + type, so a briefing tells a new session how to take a card up
--
-- Special considerations:
--   - SECURITY INVOKER throughout, as before: the caller's RLS decides.
--   - The event columns are prefixed with card_ because card_events already
--     has a column named type: the event's own kind.
--   - A type change asks for no reason, like a severity change: it rides on
--     the same edited event as a text change, so the history stays one stream.

set search_path = public, extensions;

-- 1. the column, and the types an edit or a move set ------------------------------

alter table public.cards
  add column type text
    check (type is null or type in ('story', 'bug', 'task', 'spike'));

comment on column public.cards.type is
  'Why the work exists: story, bug, task or spike. Null only on a card '
  'written before types, which declares one on its way into active. A '
  'declaration for readers: nothing sorts, gates or dispatches by it.';

-- The update grant on cards is column by column, so that a card's scope
-- can never be rewritten; the new column joins the writable set.
grant update (type) on public.cards to authenticated;

alter table public.card_events
  add column from_card_type text
    check (from_card_type is null
           or from_card_type in ('story', 'bug', 'task', 'spike')),
  add column to_card_type text
    check (to_card_type is null
           or to_card_type in ('story', 'bug', 'task', 'spike')),
  -- A type is set only by an edit (from the old one) or by a move that
  -- declares it (from none); a before without an after means nothing.
  add constraint card_events_card_type_check check (
    (to_card_type is not null or from_card_type is null)
    and (to_card_type is null or type in ('edited', 'moved'))
  );

comment on column public.card_events.from_card_type is
  'On an edited row that changed the type: the type it replaced. Null on a '
  'moved row that declared the first one.';
comment on column public.card_events.to_card_type is
  'On an edited row that changed the type, or a moved row that declared it: '
  'the type it set.';

-- The refusal every command gives a type the vocabulary does not have.
create or replace function private.card_type_refusal(p_type text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
           when p_type is null
             or p_type in ('story', 'bug', 'task', 'spike') then null
           else jsonb_build_object('error', 'invalid',
             'message', 'A card''s type is one of story, bug, task or spike.')
         end;
$$;

-- 2. one card, as every read returns it ----------------------------------------

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
    'severity', p_card.severity,
    'type', p_card.type,
    'revision', p_card.revision,
    'origin_loop_id', p_card.origin_loop_id,
    'created_by', p_card.created_by,
    'created_at', p_card.created_at,
    'updated_at', p_card.updated_at,
    'archived_at', p_card.archived_at
  );
$$;

-- 3. create and promote take a type, and refuse a card without one -------------

drop function if exists public.card_create(
  text, text, text, text, text, text, text, text, text, text, text, jsonb,
  text, integer);

create function public.card_create(
  p_scope text,
  p_title text,
  p_body text default '',
  p_state text default 'idea',
  p_origin_loop_id text default null,
  p_thread text default null,
  p_agent_label text default null,
  p_idempotency_key text default null,
  p_branch_repo text default null,
  p_branch_name text default null,
  p_no_branch text default null,
  p_links jsonb default null,
  p_no_links text default null,
  p_severity integer default 3,
  p_type text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_card public.cards;
  v_number integer;
  v_state text := coalesce(p_state, 'idea');
  v_has_branch boolean := p_branch_repo is not null or p_branch_name is not null;
  v_no_branch text := nullif(btrim(coalesce(p_no_branch, '')), '');
  v_no_links text := nullif(btrim(coalesce(p_no_links, '')), '');
  v_severity integer := coalesce(p_severity, 3);
  v_refusal jsonb;
begin
  -- A level is one of five; anything else is a mistake, not a card.
  if v_severity not between 1 and 5 then
    return jsonb_build_object('error', 'invalid',
      'message', 'severity is a whole number from 1 (minimal) to 5 (urgent).');
  end if;

  -- Every new card says why its work exists, before anything else is asked
  -- of it: the type rule has no candidates to offer, so it goes first.
  if p_type is null then
    return jsonb_build_object('error', 'type_required',
      'message', 'Say why the work exists: pass type — story, bug, task or '
                 'spike.');
  end if;
  v_refusal := private.card_type_refusal(p_type);
  if v_refusal is not null then
    return v_refusal;
  end if;

  -- The branch rule, decided before anything is written.
  if p_no_branch is not null and v_no_branch is null then
    return jsonb_build_object('error', 'invalid',
      'message', 'no_branch must say why the work has no code.');
  end if;
  if v_has_branch and v_no_branch is not null then
    return jsonb_build_object('error', 'invalid',
      'message', 'Pass branch or no_branch, not both.');
  end if;
  if (v_has_branch or v_no_branch is not null) and v_state <> 'active' then
    return jsonb_build_object('error', 'invalid',
      'message', 'branch and no_branch apply to work entering active.');
  end if;
  if v_has_branch and (not private.is_git_repo_identity(p_branch_repo)
                       or not private.is_git_branch_name(p_branch_name)) then
    return jsonb_build_object('error', 'invalid',
      'message', 'A branch is {repo, name}: the repository as owner/name '
                 '(or its folder name) and a git branch name.');
  end if;
  if v_state = 'active' and not v_has_branch and v_no_branch is null then
    return jsonb_build_object('error', 'branch_required',
      'message', 'Work entering active needs its branch: pass branch '
                 '{repo, name}, where repo is owner/name from the git remote '
                 'origin (or the repository folder name without one), or '
                 'no_branch saying why the work has no code.');
  end if;

  -- The relation rule: a new card states its relations or why it has none.
  if p_no_links is not null and
     (v_no_links is null or length(v_no_links) > 500) then
    return jsonb_build_object('error', 'invalid',
      'message', 'no_links must say, in 1 to 500 characters, why the card '
                 'relates to no other card.');
  end if;
  if p_links is not null and v_no_links is not null then
    return jsonb_build_object('error', 'invalid',
      'message', 'Pass links or no_links, not both.');
  end if;
  if p_links is null and v_no_links is null then
    return jsonb_build_object(
      'error', 'links_required',
      'message', 'Say how this card relates to the board: pass links '
                 '[{card, relation, reason}] or no_links saying why it '
                 'relates to no other card.',
      'candidates', private.card_link_candidates(
        p_scope::extensions.ltree,
        coalesce(p_title, '') || ' ' || coalesce(p_body, ''), null));
  end if;
  if p_links is not null then
    v_refusal := private.card_links_shape(p_links);
    if v_refusal is not null then
      return v_refusal;
    end if;
  end if;

  -- Relations first, like every command that writes one: see
  -- private.card_links_lock.
  if p_links is not null then
    perform private.card_links_lock();
  end if;

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
        'message', format('That loop already has a card: ZM-%s "%s" (%s).',
                          v_card.number, v_card.title, v_card.id),
        'card', private.card_json(v_card));
    end if;
  end if;

  select coalesce(max(number), 0) + 1 into v_number
    from public.cards
   where scope operator(extensions.=) p_scope::extensions.ltree;

  -- The card and the relations it declares are one write: a refused relation
  -- undoes the card.
  begin
    insert into public.cards
      (scope, number, title, body, state, severity, type, origin_loop_id,
       idempotency_key)
    values
      (p_scope::extensions.ltree, v_number, btrim(p_title),
       coalesce(p_body, ''), v_state, v_severity, p_type, p_origin_loop_id,
       p_idempotency_key)
    returning * into v_card;

    insert into public.card_events
      (card_id, scope, seq, type, agent_label, thread, to_state, branch_note,
       links_note)
    values
      (v_card.id, v_card.scope, 1, 'created', p_agent_label, p_thread,
       v_card.state, v_no_branch, v_no_links);

    if v_has_branch then
      -- Validated above and new to this card, so this cannot refuse.
      perform private.card_branch_open(v_card, p_branch_repo, p_branch_name,
                                       p_thread, p_agent_label);
    end if;

    if p_links is not null then
      v_refusal := private.card_links_declare(v_card, p_links, p_thread,
                                              p_agent_label);
      if v_refusal is not null then
        raise exception using errcode = 'ZM001',
                              message = 'a declared relation was refused';
      end if;
    end if;
  exception when sqlstate 'ZM001' then
    return v_refusal;
  end;

  if v_no_links is not null then
    -- The card said it relates to nothing; what the board suggests is handed
    -- back so the agent can reconsider with one call.
    return jsonb_build_object(
      'card', private.card_json(v_card),
      'replayed', false,
      'candidates', private.card_link_candidates(
        v_card.scope, v_card.title || ' ' || v_card.body, v_card.id));
  end if;
  return jsonb_build_object('card', private.card_json(v_card),
                            'replayed', false);
end;
$$;

comment on function public.card_create(
  text, text, text, text, text, text, text, text, text, text, text, jsonb,
  text, integer, text) is
  'Open a card: allocate the next project-local number in the scope and write '
  'its first event. A card opened in active names its branch, or says why '
  'the work has no code; every new card names its relations, or says why it '
  'has none, its severity (1 to 5), or sits at normal, and its type: story, '
  'bug, task or spike.';

drop function if exists public.card_promote_loop(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  integer);

create function public.card_promote_loop(
  p_loop_id text,
  p_title text,
  p_body text default '',
  p_state text default 'active',
  p_thread text default null,
  p_agent_label text default null,
  p_idempotency_key text default null,
  p_branch_repo text default null,
  p_branch_name text default null,
  p_no_branch text default null,
  p_links jsonb default null,
  p_no_links text default null,
  p_severity integer default 3,
  p_type text default null
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
    p_agent_label, p_idempotency_key, p_branch_repo, p_branch_name,
    p_no_branch, p_links, p_no_links, p_severity, p_type);
end;
$$;

comment on function public.card_promote_loop(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  integer, text) is
  'Promote an open loop into a card, recording where the work came from. The '
  'loop itself is untouched: it was handed over, not finished. The card names '
  'its relations, or says why it has none, and its type.';

-- 4. edit sets a type, and records the one it replaced ---------------------------

drop function if exists public.card_edit(
  text, text, text, integer, text, text, integer);

create function public.card_edit(
  p_card_id text,
  p_title text default null,
  p_body text default null,
  p_expected_revision integer default null,
  p_thread text default null,
  p_agent_label text default null,
  p_severity integer default null,
  p_type text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_card public.cards;
  v_title text;
  v_body text;
  v_severity integer;
  v_from integer;
  v_type text;
  v_from_type text;
  v_refusal jsonb;
  v_seq bigint;
begin
  -- A level is one of five; anything else is a mistake, not an edit.
  if p_severity is not null and p_severity not between 1 and 5 then
    return jsonb_build_object('error', 'invalid',
      'message', 'severity is a whole number from 1 (minimal) to 5 (urgent).');
  end if;
  v_refusal := private.card_type_refusal(p_type);
  if v_refusal is not null then
    return v_refusal;
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
  if p_expected_revision is not null
     and p_expected_revision <> v_card.revision then
    return jsonb_build_object('error', 'conflict', 'revision', v_card.revision);
  end if;

  v_title := coalesce(btrim(p_title), v_card.title);
  v_body := coalesce(p_body, v_card.body);
  v_severity := coalesce(p_severity, v_card.severity);
  v_from := v_card.severity;
  v_type := coalesce(p_type, v_card.type);
  v_from_type := v_card.type;
  if v_title = v_card.title and v_body = v_card.body
     and v_severity = v_card.severity
     and v_type is not distinct from v_card.type then
    -- Nothing changed: no revision, no event. A stream of empty edits would
    -- bury the moves that matter.
    return jsonb_build_object('card', private.card_json(v_card),
                              'changed', false);
  end if;

  update public.cards
     set title = v_title, body = v_body, severity = v_severity, type = v_type,
         revision = v_card.revision + 1, updated_at = now()
   where id = p_card_id
  returning * into v_card;

  select coalesce(max(seq), 0) + 1 into v_seq
    from public.card_events where card_id = p_card_id;

  -- The levels and the types the edit moved between ride on the edit event;
  -- an edit of the text alone carries none. A first type declared by an edit
  -- replaced none.
  insert into public.card_events
    (card_id, scope, seq, type, agent_label, thread, revision,
     from_severity, to_severity, from_card_type, to_card_type)
  values
    (p_card_id, v_card.scope, v_seq, 'edited', p_agent_label, p_thread,
     v_card.revision,
     case when v_from <> v_severity then v_from end,
     case when v_from <> v_severity then v_severity end,
     case when v_from_type is distinct from v_type then v_from_type end,
     case when v_from_type is distinct from v_type then v_type end);

  return jsonb_build_object('card', private.card_json(v_card),
                            'changed', true);
end;
$$;

comment on function public.card_edit(
  text, text, text, integer, text, text, integer, text) is
  'Rewrite a card''s text, or set its severity or its type: a new level or '
  'type is recorded on the edit event with the one it replaced. An edit '
  'naming an older revision is refused so two writers cannot silently '
  'overwrite each other.';

-- 5. move declares a type, and asks for one on the way into active -------------

drop function if exists public.card_move(
  text, text, text, text, text, text, text, text, text, text, jsonb, text);

create function public.card_move(
  p_card_id text,
  p_to_state text,
  p_reason text,
  p_thread text default null,
  p_agent_label text default null,
  p_idempotency_key text default null,
  p_branch_repo text default null,
  p_branch_name text default null,
  p_no_branch text default null,
  p_not_landed text default null,
  p_links jsonb default null,
  p_no_links text default null,
  p_type text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_card public.cards;
  v_from text;
  v_seq bigint;
  v_has_branch boolean := p_branch_repo is not null or p_branch_name is not null;
  v_no_branch text := nullif(btrim(coalesce(p_no_branch, '')), '');
  v_not_landed text := nullif(btrim(coalesce(p_not_landed, '')), '');
  v_no_links text := nullif(btrim(coalesce(p_no_links, '')), '');
  v_open text;
  v_refusal jsonb;
  v_declares boolean;
begin
  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('error', 'invalid',
                              'message', 'A move must carry a reason.');
  end if;
  if p_no_branch is not null and v_no_branch is null then
    return jsonb_build_object('error', 'invalid',
      'message', 'no_branch must say why the work has no code.');
  end if;
  if p_not_landed is not null and v_not_landed is null then
    return jsonb_build_object('error', 'invalid',
      'message', 'not_landed must say why the open branch has not landed.');
  end if;
  if v_has_branch and v_no_branch is not null then
    return jsonb_build_object('error', 'invalid',
      'message', 'Pass branch or no_branch, not both.');
  end if;
  if (v_has_branch or v_no_branch is not null) and p_to_state <> 'active' then
    return jsonb_build_object('error', 'invalid',
      'message', 'branch and no_branch apply to work entering active.');
  end if;
  if p_no_links is not null and
     (v_no_links is null or length(v_no_links) > 500) then
    return jsonb_build_object('error', 'invalid',
      'message', 'no_links must say, in 1 to 500 characters, why the card '
                 'relates to no other card.');
  end if;
  if p_links is not null and v_no_links is not null then
    return jsonb_build_object('error', 'invalid',
      'message', 'Pass links or no_links, not both.');
  end if;
  if (p_links is not null or v_no_links is not null)
     and p_to_state <> 'active' then
    return jsonb_build_object('error', 'invalid',
      'message', 'links and no_links apply to work entering active; relate '
                 'cards at any time with link.');
  end if;
  if p_links is not null then
    v_refusal := private.card_links_shape(p_links);
    if v_refusal is not null then
      return v_refusal;
    end if;
  end if;
  v_refusal := private.card_type_refusal(p_type);
  if v_refusal is not null then
    return v_refusal;
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
  -- Relations first, like every command that writes one: see
  -- private.card_links_lock.
  if p_links is not null then
    perform private.card_links_lock();
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

  -- A move declares a type; it never changes one. The same type again is no
  -- change at all.
  if p_type is not null and v_card.type is not null
     and p_type <> v_card.type then
    return jsonb_build_object('error', 'invalid',
      'message', format('This card is already a %s. A declared type is '
                        'changed with edit.', v_card.type));
  end if;
  v_declares := p_type is not null and v_card.type is null;

  -- Entering active: a card written before types says why its work exists.
  if p_to_state = 'active' and v_card.type is null and p_type is null then
    return jsonb_build_object('error', 'type_required',
      'message', 'This card never said why its work exists: pass type — '
                 'story, bug, task or spike.');
  end if;

  -- Entering active: the branch, a declaration, or a branch already open.
  if p_to_state = 'active' and not v_has_branch and v_no_branch is null
     and not exists (select 1 from public.card_branches
                      where card_id = p_card_id and state = 'open') then
    return jsonb_build_object('error', 'branch_required',
      'message', 'Work entering active needs its branch: pass branch '
                 '{repo, name}, where repo is owner/name from the git remote '
                 'origin (or the repository folder name without one), or '
                 'no_branch saying why the work has no code.');
  end if;

  -- Entering active: a card whose relations were never assessed states them.
  if p_to_state = 'active' and p_links is null and v_no_links is null
     and not private.card_links_assessed(p_card_id) then
    return jsonb_build_object(
      'error', 'links_required',
      'message', 'This card never said how it relates to the board: pass '
                 'links [{card, relation, reason}] or no_links saying why it '
                 'relates to no other card.',
      'candidates', private.card_link_candidates(
        v_card.scope, v_card.title || ' ' || v_card.body, v_card.id));
  end if;

  -- Leaving active: an open branch is landed first, or said not to be.
  if v_card.state = 'active' then
    select string_agg(b.repo || ':' || b.branch, ', '
                      order by b.attached_at, b.repo, b.branch)
      into v_open
      from public.card_branches b
     where b.card_id = p_card_id and b.state = 'open';
    if v_open is not null and v_not_landed is null then
      return jsonb_build_object('error', 'branch_open',
        'message', format('Branch %s is still open on this card. If it '
                          'landed, record it with land (the squash commit '
                          'and the branch it landed on); if it did not, pass '
                          'not_landed saying why.', v_open));
    end if;
  end if;
  if v_not_landed is not null and v_open is null then
    return jsonb_build_object('error', 'invalid',
      'message', 'not_landed applies to work leaving active with a branch '
                 'still open.');
  end if;

  -- The branch it opens, the relations it declares and the move are one
  -- write: a refused relation leaves no branch opened or reopened behind.
  begin
    if v_has_branch then
      v_refusal := private.card_branch_open(v_card, p_branch_repo,
                                            p_branch_name, p_thread,
                                            p_agent_label);
      if v_refusal is not null then
        raise exception using errcode = 'ZM001',
                              message = 'the branch was refused';
      end if;
    end if;

    if p_links is not null then
      v_refusal := private.card_links_declare(v_card, p_links, p_thread,
                                              p_agent_label);
      if v_refusal is not null then
        raise exception using errcode = 'ZM001',
                              message = 'a declared relation was refused';
      end if;
    end if;

    v_from := v_card.state;
    -- A declared type is a change of content, like an edit: it bumps the
    -- revision, so a writer holding the card's older revision gets a
    -- conflict instead of silently overwriting the type.
    update public.cards
       set state = p_to_state, type = coalesce(v_card.type, p_type),
           revision = v_card.revision
                      + case when v_declares then 1 else 0 end,
           updated_at = now()
     where id = p_card_id
    returning * into v_card;

    select coalesce(max(seq), 0) + 1 into v_seq
      from public.card_events where card_id = p_card_id;

    -- A type this move declared rides on the move event, from none, with
    -- the revision it made.
    insert into public.card_events
      (card_id, scope, seq, type, agent_label, thread,
       from_state, to_state, reason, idempotency_key, branch_note, links_note,
       revision, to_card_type)
    values
      (p_card_id, v_card.scope, v_seq, 'moved', p_agent_label, p_thread,
       v_from, p_to_state, btrim(p_reason), p_idempotency_key,
       coalesce(v_no_branch, v_not_landed), v_no_links,
       case when v_declares then v_card.revision end,
       case when v_declares then p_type end);
  exception when sqlstate 'ZM001' then
    return v_refusal;
  end;

  return jsonb_build_object('card', private.card_json(v_card),
                            'replayed', false);
end;
$$;

comment on function public.card_move(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text) is
  'Declare where the work now stands, with the reason. Work entering active '
  'names its branch (or why it has none), and a card that never assessed its '
  'relations states them, as does a card written before types its type; a '
  'type on a move only declares a card that has none. Work leaving active '
  'lands its open branch first (card_land) or says why it has not.';

-- 6. every read carries it ------------------------------------------------------

create or replace function public.board_list(
  p_scope text default null,
  p_state text default null,
  p_query text default null,
  p_include_archived boolean default false,
  p_limit integer default 50,
  p_related_to text default null,
  p_relation text default 'any',
  p_worked_by_me boolean default false
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  -- A query shaped like a card's label — ZM-42, #42 or a bare 42 — also
  -- names a card number. A label is per project, so across every board it
  -- finds that number on each one.
  v_number integer := (
    select m[1]::integer
      from regexp_match(btrim(coalesce(p_query, '')),
                        '^(?:zm-|#)?([0-9]{1,9})$', 'i') as m
  );
  v_mine boolean := coalesce(p_worked_by_me, false);
  v_horizon integer := private.continuation_horizon_days();
  v_cards jsonb;
  v_totals jsonb;
  v_related text;
begin
  -- Narrowed to the cards related to one card: above it (its parent, its
  -- blockers, what it depends on), below it (its children, what it blocks,
  -- what depends on it) or any relation at all.
  if coalesce(p_relation, 'any') not in ('any', 'above', 'below') then
    return jsonb_build_object('error', 'invalid',
      'message', 'relation is any, above or below.');
  end if;
  if p_related_to is not null then
    v_related := case
      when p_scope is not null
        then private.card_ref_resolve(p_scope::extensions.ltree, p_related_to)
      else (select c.id from public.cards c where c.id = p_related_to)
    end;
    if v_related is null then
      return jsonb_build_object('error', 'not_found',
        'message', format('No card %s here, or none you can see.',
                          p_related_to));
    end if;
  end if;

  -- One order everywhere, the board's own: the caller's cards are listed
  -- like the board lists them.
  select coalesce(jsonb_agg(listed.card order by listed.updated_at desc),
                  '[]'::jsonb)
    into v_cards
    from (
      select jsonb_build_object(
               'id', c.id,
               'scope', c.scope::text,
               'number', c.number,
               'title', c.title,
               'state', c.state,
               'severity', c.severity,
               'type', c.type,
               'updated_at', c.updated_at,
               'archived_at', c.archived_at,
               'refs', (select count(*) from public.card_refs r
                         where r.card_id = c.id),
               'last_event', case
                 when le.created_at is null then null
                 else jsonb_build_object(
                        'type', le.type, 'reason', le.reason,
                        'created_at', le.created_at)
               end,
               -- The latest production state that carried the card.
               'released_in', (
                 select e.release_version from public.card_events e
                  where e.card_id = c.id and e.type = 'released'
                  order by e.seq desc limit 1),
               -- WHY the card sits in this column, which is a different
               -- question from what happened to it last: an attachment or a
               -- note carries no reason, and a board whose tiles showed the
               -- latest touch would hide the justification behind it.
               'state_reason', (
                 select e.reason
                   from public.card_events e
                  where e.card_id = c.id
                    and e.type in ('moved', 'archived')
                  order by e.seq desc
                  limit 1),
               -- A live blocker that is neither done nor archived holds it.
               'blocked', exists (
                 select 1 from public.card_links l
                   join public.cards o on o.id = l.src_card_id
                  where l.dst_card_id = c.id and l.type = 'blocks'
                    and l.invalidated_at is null
                    and o.state <> 'done' and o.archived_at is null),
               'links', (select count(*) from public.card_links l
                          where l.invalidated_at is null
                            and (l.src_card_id = c.id or l.dst_card_id = c.id))
             )
             -- Whether the card went quiet past the horizon: by its last
             -- event, anyone's, or among the caller's own cards by the
             -- caller's last work, the age a briefing counts.
             || jsonb_build_object(
                  'past_horizon', coalesce(
                    case when v_mine then m.created_at else le.created_at end
                      <= now() - make_interval(days => v_horizon),
                    false))
             -- The caller's own latest step: only when they asked for
             -- their cards.
             || case when v_mine then jsonb_build_object(
                  'my_last', jsonb_build_object(
                    'type', m.type,
                    'from_state', m.from_state,
                    'to_state', m.to_state,
                    'text', m.said,
                    'created_at', m.created_at))
                else '{}'::jsonb end as card,
             c.updated_at
        from public.cards c
        left join lateral (
          select e.type, e.reason, e.created_at
            from public.card_events e
           where e.card_id = c.id
           order by e.seq desc
           limit 1
        ) le on true
        left join (
          select distinct on (w.card_id)
                 w.card_id, w.seq, w.type, w.from_state, w.to_state, w.said,
                 w.created_at
            from private.card_own_work(p_scope) w
           where v_mine
           order by w.card_id, w.created_at desc, w.seq desc
        ) m on m.card_id = c.id
       where (p_scope is null
              or c.scope operator(extensions.=) p_scope::extensions.ltree)
         and (p_state is null or c.state = p_state)
         and (p_include_archived or c.archived_at is null)
         and (p_query is null or btrim(p_query) = ''
              or c.title ilike '%' || btrim(p_query) || '%'
              or c.number = v_number)
         and (v_related is null
              or c.id in (select r.card_id
                            from private.card_related_ids(
                                   v_related, coalesce(p_relation, 'any')) r))
         -- Only the cards with the caller's own work, when asked for.
         and (not v_mine or m.card_id is not null)
       order by c.updated_at desc
       limit v_limit
    ) listed;

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

  return jsonb_build_object('cards', v_cards, 'totals', v_totals,
                            'horizon_days', v_horizon);
end;
$$;

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
  v_branches jsonb;
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
             'preview', r.preview,
             -- A memory attachment carries the memory's own kind, which is
             -- how a card groups what it points at.
             'memory_kind', r.memory_kind
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
             end as preview,
             case cr.kind when 'memory' then m.kind end as memory_kind
        from public.card_refs cr
        left join public.memories m
          on cr.kind = 'memory' and m.id = cr.target
        left join public.entities e
          on cr.kind = 'entity' and e.id = cr.target
        left join public.cards c
          on cr.kind = 'card' and c.id = cr.target
       where cr.card_id = p_card_id
    ) r;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'repo', b.repo,
             'branch', b.branch,
             'state', b.state,
             'squash_sha', b.squash_sha,
             'target', b.target_branch,
             'landed_at', b.landed_at,
             'attached_at', b.attached_at,
             -- Every landing of this branch, oldest first: the row above
             -- keeps only the latest, the history keeps them all.
             'landings', (
               select coalesce(jsonb_agg(
                        jsonb_build_object(
                          'squash_sha', e.squash_sha,
                          'target', e.target_branch,
                          'landed_at', e.created_at
                        ) order by e.seq
                      ), '[]'::jsonb)
                 from public.card_events e
                where e.card_id = b.card_id
                  and e.type = 'landed'
                  and e.ref_target = b.repo || ':' || b.branch
             )
           ) order by b.attached_at, b.repo, b.branch
         ), '[]'::jsonb)
    into v_branches
    from public.card_branches b
   where b.card_id = p_card_id;

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
               'branch_note', branch_note,
               'squash_sha', squash_sha,
               'target_branch', target_branch,
               'release_version', release_version,
               'release_build', release_build,
               'release_commit', release_commit,
               'link_type', link_type,
               'link_direction', link_direction,
               'links_note', links_note,
               -- The other card of a relation, by its label, when the reader
               -- may see it.
               'ref_number', case when ref_kind = 'card' then (
                 select o.number from public.cards o
                  where o.id = card_events.ref_target) end,
               -- The levels an edit moved the severity between.
               'from_severity', from_severity,
               'to_severity', to_severity,
               -- The types an edit changed between, or a move declared.
               'from_card_type', from_card_type,
               'to_card_type', to_card_type,
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
    'branches', v_branches,
    -- Every production state that carried the card, newest first.
    'releases', coalesce((
      select jsonb_agg(jsonb_build_object(
               'version', e.release_version, 'build', e.release_build,
               'release_commit', e.release_commit, 'released_at', e.created_at)
             order by e.seq desc)
        from public.card_events e
       where e.card_id = p_card_id and e.type = 'released'), '[]'::jsonb),
    -- Its live relations the reader can see, each named from this card's
    -- side; whether a live blocker holds it; whether its relations were ever
    -- assessed.
    'links', private.card_link_views(p_card_id),
    'blocked', jsonb_array_length(private.card_blocked_by(p_card_id)) > 0,
    'links_assessed', private.card_links_assessed(p_card_id),
    'events', v_events,
    'has_more', v_remaining > v_limit,
    'next_after_seq', coalesce(
      (select max((e->>'seq')::bigint) from jsonb_array_elements(v_events) e),
      coalesce(p_after_seq, 0))
  );
end;
$$;

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
             'severity', c.severity,
             'type', c.type,
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
               'severity', lead.severity,
               'type', lead.type,
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
      select c.id, c.number, c.title, c.state, c.severity, c.type,
             c.updated_at
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
               'severity', c.severity,
               'type', c.type,
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

-- 7. grants ---------------------------------------------------------------------

revoke all on function private.card_type_refusal(text)
  from public, anon, authenticated;
revoke all on function public.card_create(
  text, text, text, text, text, text, text, text, text, text, text, jsonb,
  text, integer, text) from public, anon;
revoke all on function public.card_promote_loop(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  integer, text) from public, anon;
revoke all on function public.card_edit(
  text, text, text, integer, text, text, integer, text) from public, anon;
revoke all on function public.card_move(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text) from public, anon;

grant execute on function private.card_type_refusal(text)
  to authenticated, service_role;
grant execute on function public.card_create(
  text, text, text, text, text, text, text, text, text, text, text, jsonb,
  text, integer, text) to authenticated, service_role;
grant execute on function public.card_promote_loop(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  integer, text) to authenticated, service_role;
grant execute on function public.card_edit(
  text, text, text, integer, text, text, integer, text)
  to authenticated, service_role;
grant execute on function public.card_move(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text) to authenticated, service_role;
