-- Migration: work answers for its branch when it enters and leaves active
--
-- Purpose:
--   A card's state went stale whenever the agent that landed the work forgot
--   to move it, and a card had no way to say where its code was. The board
--   commands now hold the line a reminder could not:
--   - work ENTERS active with the branch it runs on, with a stated reason for
--     having none, or on a branch the card already holds open;
--   - work LEAVES active only after its open branch is landed (card_land), or
--     with a stated reason why it has not;
--   - card_land records the squash commit and the branch it landed on, and
--     moves the card in the same transaction, by default to waiting.
--   Nothing here moves a card by itself: the rule refuses a move, it never
--   makes one.
--
-- Affected objects:
--   - function: private.card_branch_open (new)
--   - function: public.card_create, public.card_promote_loop,
--     public.card_move (dropped and recreated with the branch parameters,
--     every new one defaulted)
--   - function: public.card_land (new)
--   - function: public.briefing_work (replaced, same signature: adds
--     open_branches)
--   - function: public.card_resolve (comment only: a card is labelled ZM-N)
--
-- Special considerations:
--   - ONE SIGNATURE PER COMMAND. The previous server keeps calling these by
--     name with its own arguments until its container is replaced. A call by
--     name resolves to the recreated function because every new parameter has
--     a default; two overloads side by side would make PostgREST refuse to
--     choose between them. The rules bind that server too from the moment
--     this applies: its move into active without a branch is refused, with a
--     message that says what to pass.
--   - Every refusal is decided before the first write, so a refused call
--     leaves nothing behind.
--   - Recreating drops grants and comments, so both are restated below.
--   - card_create and briefing_work restate their bodies from the promoted
--     loop migration; card_promote_loop and card_move from the board commands
--     migration.

set search_path = public, extensions;

-- 1. opening a branch on a card ----------------------------------------------

-- Record an open branch inside the caller's transaction. Returns a refusal
-- (nothing written) or null: a branch already open is reused, a new one is
-- inserted with its `attached` event. A branch that already LANDED is refused
-- — follow-up work goes on a new branch.
create or replace function private.card_branch_open(
  p_card public.cards,
  p_repo text,
  p_branch text,
  p_thread text,
  p_agent_label text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_existing public.card_branches;
  v_seq bigint;
begin
  if not private.is_git_repo_identity(p_repo)
     or not private.is_git_branch_name(p_branch) then
    return jsonb_build_object(
      'error', 'invalid',
      'message', 'A branch is {repo, name}: the repository as owner/name '
                 '(or its folder name) and a git branch name.');
  end if;

  select * into v_existing from public.card_branches
   where card_id = p_card.id and repo = p_repo and branch = p_branch;
  if found then
    if v_existing.state = 'landed' then
      return jsonb_build_object(
        'error', 'invalid',
        'message', format('Branch %s:%s already landed as %s; follow-up work '
                          'goes on a new branch.',
                          p_repo, p_branch, v_existing.squash_sha));
    end if;
    return null;
  end if;

  insert into public.card_branches (card_id, scope, repo, branch)
  values (p_card.id, p_card.scope, p_repo, p_branch);

  select coalesce(max(seq), 0) + 1 into v_seq
    from public.card_events where card_id = p_card.id;

  insert into public.card_events
    (card_id, scope, seq, type, agent_label, thread, ref_kind, ref_target)
  values
    (p_card.id, p_card.scope, v_seq, 'attached', p_agent_label, p_thread,
     'branch', p_repo || ':' || p_branch);

  return null;
end;
$$;

-- 2. create -------------------------------------------------------------------

drop function if exists public.card_create(
  text, text, text, text, text, text, text, text);

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
  p_no_branch text default null
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
begin
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

  insert into public.cards
    (scope, number, title, body, state, origin_loop_id, idempotency_key)
  values
    (p_scope::extensions.ltree, v_number, btrim(p_title), coalesce(p_body, ''),
     v_state, p_origin_loop_id, p_idempotency_key)
  returning * into v_card;

  insert into public.card_events
    (card_id, scope, seq, type, agent_label, thread, to_state, branch_note)
  values
    (v_card.id, v_card.scope, 1, 'created', p_agent_label, p_thread,
     v_card.state, v_no_branch);

  if v_has_branch then
    -- Validated above and new to this card, so this cannot refuse.
    perform private.card_branch_open(v_card, p_branch_repo, p_branch_name,
                                     p_thread, p_agent_label);
  end if;

  return jsonb_build_object('card', private.card_json(v_card),
                            'replayed', false);
end;
$$;

comment on function public.card_create(
  text, text, text, text, text, text, text, text, text, text, text) is
  'Open a card: allocate the next project-local number in the scope and write '
  'its first event. A card opened in active names its branch, or says why '
  'the work has no code.';

-- A card is labelled ZM-N everywhere, so the address this resolves says so.
comment on function public.card_resolve(text, integer) is
  'A short address resolves only inside a named scope: ZM-42 means nothing '
  'without one, and the same number in another project is another card.';

-- 3. promote a loop -----------------------------------------------------------

drop function if exists public.card_promote_loop(
  text, text, text, text, text, text, text);

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
  p_no_branch text default null
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
    p_no_branch);
end;
$$;

comment on function public.card_promote_loop(
  text, text, text, text, text, text, text, text, text, text) is
  'Promote an open loop into a card, recording where the work came from. The '
  'loop itself is untouched: it was handed over, not finished.';

-- 4. move ----------------------------------------------------------------------

drop function if exists public.card_move(text, text, text, text, text, text);

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
  p_not_landed text default null
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
  v_open text;
  v_refusal jsonb;
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

  if v_has_branch then
    v_refusal := private.card_branch_open(v_card, p_branch_repo,
                                          p_branch_name, p_thread,
                                          p_agent_label);
    if v_refusal is not null then
      return v_refusal;
    end if;
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
     from_state, to_state, reason, idempotency_key, branch_note)
  values
    (p_card_id, v_card.scope, v_seq, 'moved', p_agent_label, p_thread,
     v_from, p_to_state, btrim(p_reason), p_idempotency_key,
     coalesce(v_no_branch, v_not_landed));

  return jsonb_build_object('card', private.card_json(v_card),
                            'replayed', false);
end;
$$;

comment on function public.card_move(
  text, text, text, text, text, text, text, text, text, text) is
  'Declare where the work now stands, with the reason. Work entering active '
  'names its branch (or why it has none); work leaving active lands its open '
  'branch first (card_land) or says why it has not.';

-- 5. land ----------------------------------------------------------------------

create function public.card_land(
  p_card_id text,
  p_repo text,
  p_branch text,
  p_squash_sha text,
  p_target text,
  p_reason text,
  p_to_state text default 'waiting',
  p_not_landed text default null,
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
  v_existing public.card_branches;
  v_sha text := lower(btrim(coalesce(p_squash_sha, '')));
  v_to text := coalesce(p_to_state, 'waiting');
  v_not_landed text := nullif(btrim(coalesce(p_not_landed, '')), '');
  v_from text;
  v_moves boolean;
  v_open text;
  v_seq bigint;
begin
  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('error', 'invalid',
      'message', 'A landing must carry a reason: what the gate proved and '
                 'what the card waits for.');
  end if;
  if not private.is_git_repo_identity(p_repo)
     or not private.is_git_branch_name(p_branch)
     or not private.is_git_branch_name(p_target) then
    return jsonb_build_object('error', 'invalid',
      'message', 'A landing names the repository (owner/name or its folder '
                 'name), the branch that landed and the branch it landed on.');
  end if;
  if v_sha !~ '^[0-9a-f]{7,64}$' then
    return jsonb_build_object('error', 'invalid',
      'message', 'squash_sha is the landed commit: 7 to 64 hex characters.');
  end if;
  if v_to not in ('idea', 'active', 'waiting', 'done', 'parked') then
    return jsonb_build_object('error', 'invalid',
      'message', 'Unknown state to land into.');
  end if;
  if p_not_landed is not null and v_not_landed is null then
    return jsonb_build_object('error', 'invalid',
      'message', 'not_landed must say why the other branch has not landed.');
  end if;

  if p_idempotency_key is not null
     and exists (select 1 from public.card_events
                  where card_id = p_card_id
                    and idempotency_key = p_idempotency_key) then
    select * into v_card from public.cards where id = p_card_id;
    return jsonb_build_object('card', private.card_json(v_card),
                              'changed', false, 'replayed', true);
  end if;

  -- Two reads, so the answer is honest (see card_move).
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

  select * into v_existing from public.card_branches
   where card_id = p_card_id and repo = p_repo and branch = p_branch;

  -- The same landing again, by a short or a full sha: nothing to record.
  if v_existing.card_id is not null and v_existing.state = 'landed'
     and (left(v_existing.squash_sha, length(v_sha)) = v_sha
          or left(v_sha, length(v_existing.squash_sha)) = v_existing.squash_sha)
  then
    return jsonb_build_object('card', private.card_json(v_card),
                              'changed', false, 'replayed', false);
  end if;

  v_moves := v_card.state <> v_to;

  -- Leaving active: every OTHER open branch is accounted for too.
  if v_moves and v_card.state = 'active' then
    select string_agg(b.repo || ':' || b.branch, ', '
                      order by b.attached_at, b.repo, b.branch)
      into v_open
      from public.card_branches b
     where b.card_id = p_card_id and b.state = 'open'
       and not (b.repo = p_repo and b.branch = p_branch);
    if v_open is not null and v_not_landed is null then
      return jsonb_build_object('error', 'branch_open',
        'message', format('Branch %s is also open on this card. Land it '
                          'first with to: active, or pass not_landed saying '
                          'why it has not landed.', v_open));
    end if;
  end if;
  if v_not_landed is not null and v_open is null then
    return jsonb_build_object('error', 'invalid',
      'message', 'not_landed applies when another branch is still open as '
                 'the card leaves active.');
  end if;

  if v_existing.card_id is null then
    insert into public.card_branches
      (card_id, scope, repo, branch, state, squash_sha, target_branch,
       landed_at)
    values
      (p_card_id, v_card.scope, p_repo, p_branch, 'landed', v_sha, p_target,
       now());
  else
    update public.card_branches
       set state = 'landed', squash_sha = v_sha, target_branch = p_target,
           landed_at = now()
     where card_id = p_card_id and repo = p_repo and branch = p_branch;
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
    from public.card_events where card_id = p_card_id;

  -- The reason rides on the move when there is one, else on the landing.
  insert into public.card_events
    (card_id, scope, seq, type, agent_label, thread, ref_kind, ref_target,
     squash_sha, target_branch, reason, idempotency_key)
  values
    (p_card_id, v_card.scope, v_seq, 'landed', p_agent_label, p_thread,
     'branch', p_repo || ':' || p_branch, v_sha, p_target,
     case when v_moves then null else btrim(p_reason) end,
     case when v_moves then null else p_idempotency_key end);

  v_from := v_card.state;
  update public.cards
     set state = v_to, updated_at = now()
   where id = p_card_id
  returning * into v_card;

  if v_moves then
    insert into public.card_events
      (card_id, scope, seq, type, agent_label, thread,
       from_state, to_state, reason, idempotency_key, branch_note)
    values
      (p_card_id, v_card.scope, v_seq + 1, 'moved', p_agent_label, p_thread,
       v_from, v_to, btrim(p_reason), p_idempotency_key, v_not_landed);
  end if;

  return jsonb_build_object('card', private.card_json(v_card),
                            'changed', true, 'replayed', false);
end;
$$;

comment on function public.card_land(
  text, text, text, text, text, text, text, text, text, text, text) is
  'Record that a branch landed as a squash commit on its target, and move '
  'the card in the same breath (to waiting unless told otherwise). A repeat '
  'of the same landing changes nothing.';

-- 6. the briefing names open branches ----------------------------------------

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

  -- Branches still open on live cards, freshest card first: the briefing
  -- names them next to their card, and the client checks them against git.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'card_id', ob.card_id,
             'number', ob.number,
             'state', ob.state,
             'repo', ob.repo,
             'branch', ob.branch)
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

  if v_bound is null and v_active + v_waiting = 0
     and v_open = '[]'::jsonb then
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
    'attached_loop_ids', v_loops,
    'open_branches', v_open
  );
end;
$$;

-- 7. grants --------------------------------------------------------------------

revoke all on function private.card_branch_open(
  public.cards, text, text, text, text) from public, anon;
revoke all on function public.card_create(
  text, text, text, text, text, text, text, text, text, text, text)
  from public, anon;
revoke all on function public.card_promote_loop(
  text, text, text, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.card_move(
  text, text, text, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.card_land(
  text, text, text, text, text, text, text, text, text, text, text)
  from public, anon;

grant execute on function private.card_branch_open(
  public.cards, text, text, text, text) to authenticated, service_role;
grant execute on function public.card_create(
  text, text, text, text, text, text, text, text, text, text, text)
  to authenticated, service_role;
grant execute on function public.card_promote_loop(
  text, text, text, text, text, text, text, text, text, text)
  to authenticated, service_role;
grant execute on function public.card_move(
  text, text, text, text, text, text, text, text, text, text)
  to authenticated, service_role;
grant execute on function public.card_land(
  text, text, text, text, text, text, text, text, text, text, text)
  to authenticated, service_role;
