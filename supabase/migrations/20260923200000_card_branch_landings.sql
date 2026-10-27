-- Migration: a branch keeps every landing it had
--
-- Purpose:
--   A branch can land on its target more than once: a bug found after a
--   squash is fixed in the branch that brought it, and the branch is squashed
--   again. The branch row keeps only its latest squash commit, so every
--   earlier landing looked unrecorded to anything that compares a commit
--   with the row, and recording that earlier commit again wound the row back
--   to it. Every landing is already in the card's history as a `landed`
--   event; the card now reads them from there.
--
-- Affected objects:
--   - function public.card_get: each branch carries `landings`, every landing
--     of that branch oldest first ({squash_sha, target, landed_at})
--   - function public.card_land: a squash matching any recorded landing of
--     the branch is already on record — nothing is written and the branch
--     keeps its latest landing
--
-- Special considerations:
--   - Both functions keep their signatures, so `create or replace` keeps
--     their grants and comments, and a caller that ignores `landings` reads
--     exactly what it read before.
--   - A landed branch is never reopened (follow-up work goes on a new
--     branch), so a branch with a landing in its history is always the
--     landed row this compares against.

set search_path = public, extensions;

-- 1. a card reads back every landing of each branch ---------------------------

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
    'events', v_events,
    'has_more', v_remaining > v_limit,
    'next_after_seq', coalesce(
      (select max((e->>'seq')::bigint) from jsonb_array_elements(v_events) e),
      coalesce(p_after_seq, 0))
  );
end;
$$;

-- 2. a landing already on record is not recorded again -----------------------

create or replace function public.card_land(
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

  -- A landing already on record, by a short or a full sha: nothing to
  -- record. That is the latest landing of this branch or any earlier one —
  -- a branch lands again when a fix is made in the branch that brought the
  -- bug, and recording an earlier squash again must not wind the branch
  -- back to it.
  if v_existing.card_id is not null
     and exists (
       select 1
         from public.card_events e
        where e.card_id = p_card_id
          and e.type = 'landed'
          and e.ref_target = p_repo || ':' || p_branch
          and (left(e.squash_sha, length(v_sha)) = v_sha
               or left(v_sha, length(e.squash_sha)) = e.squash_sha))
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
