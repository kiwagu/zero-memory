-- Migration: a card states its relations when it is created or picked up
--
-- Purpose:
--   A relation nobody declares is invisible to every other agent, so the
--   assessment of a card's relations is a step of the command, not a habit.
--   Creating a card (directly or by promoting a loop) names its relations
--   (`p_links`) or says why it has none (`p_no_links`); a card that never had
--   that assessment makes it when it next enters active. A refusal carries up
--   to five candidates from the same board — cards the text mentions by label
--   and cards whose words it shares — so the assessment is cheap. Candidates
--   are offered, never written.
--
--   The untyped card attachment keeps working for older clients, but what it
--   makes now is a relation: `relates_to`, marked as not declared. Every card
--   attachment already stored is carried over the same way.
--
-- Affected objects:
--   - function public.card_create: + p_links jsonb, p_no_links text
--   - function public.card_promote_loop: + p_links jsonb, p_no_links text
--   - function public.card_move: + p_links jsonb, p_no_links text
--   - functions public.card_attach, public.card_detach: a card target is a
--     relation
--   - function private.card_link_candidates (new)
--   - function private.card_links_assessed (new)
--   - function private.card_links_declare (new)
--   - function private.card_links_carry_refs (new), run once below
--
-- Special considerations:
--   - The three commands gain parameters, so each is dropped and created
--     again: one signature per command. Grants and comments are restated.
--   - A card and the relations it is created with are written together: if
--     one relation is refused (say two of them would close a loop), the card
--     is not created either. A move into active is written the same way with
--     the branch it opens and the relations it declares. The refusal travels
--     out of a subtransaction through SQLSTATE ZM001 and is returned as an
--     ordinary refusal.
--   - card_links_assessed is SECURITY DEFINER: a card is assessed when anyone
--     declared a relation of it, even one to a card the caller cannot read.
--     It answers a boolean and nothing else.

set search_path = public, extensions;

-- 1. helpers --------------------------------------------------------------------

-- Up to p_limit cards of the board p_scope a text relates to: the ones it
-- mentions by label first, then the ones whose title and body share its
-- words. Read under the caller's RLS; archived cards and p_exclude are left
-- out. Each entry says why it is offered.
create or replace function private.card_link_candidates(
  p_scope extensions.ltree,
  p_text text,
  p_exclude text,
  p_limit integer default 5
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_numbers integer[];
  v_mentioned jsonb;
  v_taken text[];
  v_words text;
  v_similar jsonb;
begin
  select coalesce(array_agg(distinct m.n::integer), '{}')
    into v_numbers
    from (
      select (regexp_matches(coalesce(p_text, ''),
                '(?<![0-9A-Za-z])ZM-([1-9][0-9]{0,9})(?![0-9A-Za-z])',
                'g'))[1]::bigint as n
    ) m
   where m.n <= 2147483647;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'number', c.number, 'title', c.title,
           'state', c.state, 'why', 'mentioned') order by c.number),
         '[]'::jsonb),
         coalesce(array_agg(c.id), '{}')
    into v_mentioned, v_taken
    from (
      select c.* from public.cards c
       where c.scope operator(extensions.=) p_scope
         and c.number = any(v_numbers)
         and c.archived_at is null
         and c.id is distinct from p_exclude
       order by c.number
       limit p_limit
    ) c;

  select string_agg(w, ' | ')
    into v_words
    from (
      select distinct w
        from regexp_split_to_table(lower(coalesce(p_text, '')),
                                   '[^[:alnum:]]+') w
       where length(w) >= 4
       limit 32
    ) t;

  if v_words is null or jsonb_array_length(v_mentioned) >= p_limit then
    return v_mentioned;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'number', s.number, 'title', s.title,
           'state', s.state, 'why', 'similar') order by s.rank desc,
                                                        s.updated_at desc),
         '[]'::jsonb)
    into v_similar
    from (
      select c.id, c.number, c.title, c.state, c.updated_at,
             ts_rank_cd(to_tsvector('simple', c.title || ' ' || c.body),
                        to_tsquery('simple', v_words)) as rank
        from public.cards c
       where c.scope operator(extensions.=) p_scope
         and c.archived_at is null
         and c.id is distinct from p_exclude
         and not (c.id = any(v_taken))
         and to_tsvector('simple', c.title || ' ' || c.body)
             @@ to_tsquery('simple', v_words)
       order by rank desc, c.updated_at desc
       limit p_limit - jsonb_array_length(v_mentioned)
    ) s;

  return v_mentioned || v_similar;
end;
$$;

-- Whether a card's relations were ever assessed: someone declared a relation
-- of it, or said why it has none.
create or replace function private.card_links_assessed(p_card_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.card_events e
                  where e.card_id = p_card_id and e.links_note is not null)
      or exists (select 1 from public.card_links l
                  where l.declared
                    and (l.src_card_id = p_card_id or l.dst_card_id = p_card_id))
$$;

-- The shape of `p_links`, checked before anything is written: an array of one
-- to twenty {card, relation, reason}. Returns a refusal or null.
create or replace function private.card_links_shape(p_links jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_index integer := 0;
  v_type text;
begin
  if jsonb_typeof(p_links) <> 'array'
     or jsonb_array_length(p_links) not between 1 and 20 then
    return jsonb_build_object(
      'error', 'invalid',
      'message', 'links is a list of 1 to 20 {card, relation, reason}; pass '
                 'no_links to say why there is none.');
  end if;
  for v_item in select * from jsonb_array_elements(p_links) loop
    v_index := v_index + 1;
    select n.link_type into v_type
      from private.card_link_normalize(v_item ->> 'relation') n;
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(v_item ->> 'card', '') = ''
       or v_type is null
       or length(btrim(coalesce(v_item ->> 'reason', ''))) not between 1 and 500
    then
      return jsonb_build_object(
        'error', 'invalid',
        'message', format('links[%s] needs a card (id or label), a relation '
                          '(blocks, blocked_by, depends_on, needed_by, '
                          'parent_of, child_of, relates_to, duplicates, '
                          'duplicated_by) and a reason of 1 to 500 '
                          'characters.', v_index));
    end if;
  end loop;
  return null;
end;
$$;

-- Write the relations a card declares, in order. The card is locked and
-- writable; each other card is resolved on the card's board, checked and
-- locked. Returns the first refusal, or null.
create or replace function private.card_links_declare(
  p_card public.cards,
  p_links jsonb,
  p_thread text,
  p_agent_label text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item jsonb;
  v_type text;
  v_swapped boolean;
  v_other_id text;
  v_other public.cards;
  v_result jsonb;
begin
  for v_item in select * from jsonb_array_elements(p_links) loop
    select n.link_type, n.swapped into v_type, v_swapped
      from private.card_link_normalize(v_item ->> 'relation') n;
    v_other_id := private.card_ref_resolve(p_card.scope, v_item ->> 'card');
    if v_other_id is null then
      return jsonb_build_object(
        'error', 'not_found',
        'message', format('No card %s on this board, or none you can see.',
                          v_item ->> 'card'));
    end if;
    if v_other_id = p_card.id then
      return jsonb_build_object('error', 'invalid',
                                'message', 'A card does not relate to itself.');
    end if;
    select * into v_other from public.cards c
     where c.id = v_other_id for update;
    if not found then
      return jsonb_build_object(
        'error', 'forbidden',
        'message', format('You may not write the board of %s.',
                          v_item ->> 'card'));
    end if;
    if v_swapped then
      v_result := private.card_link_write(
        v_other, p_card, v_type, v_item ->> 'reason', true, p_thread,
        p_agent_label, null, p_card.id);
    else
      v_result := private.card_link_write(
        p_card, v_other, v_type, v_item ->> 'reason', true, p_thread,
        p_agent_label, null, p_card.id);
    end if;
    if v_result ? 'error' then
      return v_result;
    end if;
  end loop;
  return null;
end;
$$;

-- Carry every untyped card attachment over as an untyped relation, and drop
-- the attachment. Returns how many relations it made.
create or replace function private.card_links_carry_refs()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  with carried as (
    insert into public.card_links
      (src_card_id, dst_card_id, type, src_scope, dst_scope, reason, declared,
       created_by, created_at)
    select s.id, d.id, 'relates_to', s.scope, d.scope,
           'carried over from an untyped attachment', false,
           r.attached_by, r.attached_at
      from public.card_refs r
      join public.cards s on s.id = least(r.card_id, r.target)
      join public.cards d on d.id = greatest(r.card_id, r.target)
     where r.kind = 'card' and r.card_id <> r.target
    on conflict do nothing
    returning 1
  )
  select count(*) into v_count from carried;
  delete from public.card_refs where kind = 'card';
  return v_count;
end;
$$;

-- 2. create -------------------------------------------------------------------

drop function if exists public.card_create(
  text, text, text, text, text, text, text, text, text, text, text);

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
  p_no_links text default null
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
  v_refusal jsonb;
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
      (scope, number, title, body, state, origin_loop_id, idempotency_key)
    values
      (p_scope::extensions.ltree, v_number, btrim(p_title),
       coalesce(p_body, ''), v_state, p_origin_loop_id, p_idempotency_key)
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
  text) is
  'Open a card: allocate the next project-local number in the scope and write '
  'its first event. A card opened in active names its branch, or says why '
  'the work has no code; every new card names its relations, or says why it '
  'has none.';

-- 3. promote a loop -----------------------------------------------------------

drop function if exists public.card_promote_loop(
  text, text, text, text, text, text, text, text, text, text);

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
  p_no_links text default null
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
    p_no_branch, p_links, p_no_links);
end;
$$;

comment on function public.card_promote_loop(
  text, text, text, text, text, text, text, text, text, text, jsonb, text) is
  'Promote an open loop into a card, recording where the work came from. The '
  'loop itself is untouched: it was handed over, not finished. The card names '
  'its relations, or says why it has none.';

-- 4. move ----------------------------------------------------------------------

drop function if exists public.card_move(
  text, text, text, text, text, text, text, text, text, text);

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
  p_no_links text default null
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
    update public.cards
       set state = p_to_state, updated_at = now()
     where id = p_card_id
    returning * into v_card;

    select coalesce(max(seq), 0) + 1 into v_seq
      from public.card_events where card_id = p_card_id;

    insert into public.card_events
      (card_id, scope, seq, type, agent_label, thread,
       from_state, to_state, reason, idempotency_key, branch_note, links_note)
    values
      (p_card_id, v_card.scope, v_seq, 'moved', p_agent_label, p_thread,
       v_from, p_to_state, btrim(p_reason), p_idempotency_key,
       coalesce(v_no_branch, v_not_landed), v_no_links);
  exception when sqlstate 'ZM001' then
    return v_refusal;
  end;

  return jsonb_build_object('card', private.card_json(v_card),
                            'replayed', false);
end;
$$;

comment on function public.card_move(
  text, text, text, text, text, text, text, text, text, text, jsonb, text) is
  'Declare where the work now stands, with the reason. Work entering active '
  'names its branch (or why it has none), and a card that never assessed its '
  'relations states them; work leaving active lands its open branch first '
  '(card_land) or says why it has not.';

-- 5. a card attachment is a relation --------------------------------------------

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
  v_repo text;
  v_branch text;
  v_refusal jsonb;
  v_other_id text;
  v_other public.cards;
  v_result jsonb;
begin
  -- Two reads, so the answer is honest: a card the caller cannot SEE is
  -- `not_found`, while one they can see but may not write is `forbidden`.
  -- `for update` additionally requires the update policy, so the lock alone
  -- would report a reader's lack of rights as a missing card.
  if not exists (select 1 from public.cards where id = p_card_id) then
    return jsonb_build_object('error', 'not_found');
  end if;
  -- A card attachment is a relation: its lock comes first, like every
  -- command that writes one (see private.card_links_lock).
  if p_kind = 'card' then
    perform private.card_links_lock();
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

  if p_kind = 'card' then
    -- An untyped relation, for clients that attach a card: the same row a
    -- typed relation would be, marked as not declared.
    select p.refusal, p.other_id into v_refusal, v_other_id
      from private.card_link_pair(p_card_id, p_target) p;
    if v_refusal is not null then
      return v_refusal;
    end if;
    select * into v_other from public.cards c where c.id = v_other_id;
    v_result := private.card_link_write(
      v_card, v_other, 'relates_to', 'attached as a card reference', false,
      p_thread, p_agent_label, p_idempotency_key, p_card_id);
    if v_result ? 'error' then
      return v_result;
    end if;
    return jsonb_build_object('card', private.card_json(v_card),
                              'changed', v_result is null);
  end if;

  if p_kind = 'branch' then
    -- `<repo>:<branch>`: the first `:` splits the two (neither may hold one).
    v_repo := split_part(p_target, ':', 1);
    v_branch := substr(p_target, length(v_repo) + 2);
    if position(':' in coalesce(p_target, '')) = 0
       or not private.is_git_repo_identity(v_repo)
       or not private.is_git_branch_name(v_branch) then
      return jsonb_build_object(
        'error', 'invalid',
        'message', 'A branch is <repo>:<branch>: the repository as owner/name '
                   '(or its folder name) and a git branch name.');
    end if;
    if exists (select 1 from public.card_branches
                where card_id = p_card_id and repo = v_repo
                  and branch = v_branch) then
      return jsonb_build_object('card', private.card_json(v_card),
                                'changed', false);
    end if;
    insert into public.card_branches (card_id, scope, repo, branch)
    values (p_card_id, v_card.scope, v_repo, v_branch);
  else
    if exists (select 1 from public.card_refs
                where card_id = p_card_id and kind = p_kind
                  and target = p_target) then
      -- Already attached: one target, one attachment, whoever asks again.
      return jsonb_build_object('card', private.card_json(v_card),
                                'changed', false);
    end if;
    insert into public.card_refs (card_id, scope, kind, target)
    values (p_card_id, v_card.scope, p_kind, p_target);
  end if;

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
  -- A card target is the pair's untyped-or-typed `relates_to` relation.
  if p_kind = 'card' then
    if not exists (select 1 from public.card_links l
                    where l.type = 'relates_to' and l.invalidated_at is null
                      and l.src_card_id = least(p_card_id, p_target)
                      and l.dst_card_id = greatest(p_card_id, p_target)) then
      if not exists (select 1 from public.cards where id = p_card_id) then
        return jsonb_build_object('error', 'not_found');
      end if;
      return jsonb_build_object('error', 'not_attached');
    end if;
    return public.card_unlink(p_card_id, p_target, 'relates_to',
                              'detached as a card reference', p_thread,
                              p_agent_label);
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

  if p_kind = 'branch' then
    delete from public.card_branches
     where card_id = p_card_id
       and repo = split_part(p_target, ':', 1)
       and branch = substr(p_target,
                           length(split_part(p_target, ':', 1)) + 2);
  else
    delete from public.card_refs
     where card_id = p_card_id and kind = p_kind and target = p_target;
  end if;
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

-- 6. grants ---------------------------------------------------------------------

revoke all on function private.card_link_candidates(
  extensions.ltree, text, text, integer) from public, anon;
revoke all on function private.card_links_assessed(text) from public, anon;
revoke all on function private.card_links_shape(jsonb) from public, anon;
revoke all on function private.card_links_declare(
  public.cards, jsonb, text, text) from public, anon;
revoke all on function private.card_links_carry_refs()
  from public, anon, authenticated;
revoke all on function public.card_create(
  text, text, text, text, text, text, text, text, text, text, text, jsonb,
  text) from public, anon;
revoke all on function public.card_promote_loop(
  text, text, text, text, text, text, text, text, text, text, jsonb, text)
  from public, anon;
revoke all on function public.card_move(
  text, text, text, text, text, text, text, text, text, text, jsonb, text)
  from public, anon;

grant execute on function private.card_link_candidates(
  extensions.ltree, text, text, integer) to authenticated, service_role;
grant execute on function private.card_links_assessed(text)
  to authenticated, service_role;
grant execute on function private.card_links_shape(jsonb)
  to authenticated, service_role;
grant execute on function private.card_links_declare(
  public.cards, jsonb, text, text) to authenticated, service_role;
grant execute on function private.card_links_carry_refs() to service_role;
grant execute on function public.card_create(
  text, text, text, text, text, text, text, text, text, text, text, jsonb,
  text) to authenticated, service_role;
grant execute on function public.card_promote_loop(
  text, text, text, text, text, text, text, text, text, text, jsonb, text)
  to authenticated, service_role;
grant execute on function public.card_move(
  text, text, text, text, text, text, text, text, text, text, jsonb, text)
  to authenticated, service_role;

-- 7. carry the untyped card attachments over -------------------------------------

select private.card_links_carry_refs();
