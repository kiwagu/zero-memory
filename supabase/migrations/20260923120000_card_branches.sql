-- Migration: a card records the git branches its work ran on
--
-- Purpose:
--   A card said what the work is and why it moved, but not where its code
--   lives. The branch that carried the work outlives its landing and keeps the
--   step-by-step history a squash collapses, so a card now records its
--   branches: the repository, the branch, and, once the work lands, the
--   squash commit and the branch it landed on.
--
-- Affected objects:
--   - function: private.is_git_repo_identity, private.is_git_branch_name (new)
--   - table: public.card_branches (+ RLS policies)
--   - table: public.card_events (branch_note, squash_sha and target_branch
--     columns; `landed` joins the event types and `branch` the reference
--     kinds)
--   - function: public.card_attach, public.card_detach, public.card_get
--     (replaced, same signatures)
--   - function: public.hard_delete_user(text) (replaced: card_branches joins
--     the erasure cascade)
--
-- Special considerations:
--   - A branch is not a card_refs row. An attachment is a bare pointer; a
--     branch has a lifecycle, open and then landed with a commit and a
--     target, and landing updates the same row.
--   - Written as one string, a branch is `<repo>:<branch>`: in an event's
--     ref_target and in card_attach's target. Git forbids `:` in a ref name,
--     and a repository identity (`owner/name`, or a folder name) never
--     carries one, so the first `:` always splits the two.
--   - Each replaced body is restated in full from its last definition in this
--     series, so nothing a later migration refined is lost: card_get,
--     card_attach and card_detach from the board commands migration,
--     hard_delete_user from the board tables migration.

set search_path = public, extensions;

-- 1. what a repository and a branch may be called ----------------------------

create or replace function private.is_git_repo_identity(p_repo text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_repo is not null and p_repo ~ '^[^[:space:]:]{1,200}$';
$$;

comment on function private.is_git_repo_identity(text) is
  'A repository as a card names it: owner/name from its remote, or its folder '
  'name. Never whitespace or ":", which separates it from a branch.';

create or replace function private.is_git_branch_name(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_name is not null
     and length(p_name) between 1 and 250
     and p_name !~ '[[:space:]:~^?*\[\\]'
     and position('..' in p_name) = 0
     and left(p_name, 1) <> '-'
     and right(p_name, 1) <> '/';
$$;

comment on function private.is_git_branch_name(text) is
  'A branch name git would accept, as far as a card cares: no whitespace, no '
  'ref-syntax characters, no "..", not starting with "-" or ending with "/".';

revoke all on function private.is_git_repo_identity(text) from public, anon;
revoke all on function private.is_git_branch_name(text) from public, anon;
grant execute on function private.is_git_repo_identity(text)
  to authenticated, service_role;
grant execute on function private.is_git_branch_name(text)
  to authenticated, service_role;

-- 2. card_branches -----------------------------------------------------------

create table public.card_branches (
  card_id text not null references public.cards (id) on delete cascade,
  scope extensions.ltree not null,
  repo text not null check (private.is_git_repo_identity(repo)),
  branch text not null check (private.is_git_branch_name(branch)),
  state text not null default 'open' check (state in ('open', 'landed')),
  -- The commit the branch landed as, lower-case hex. A short sha is kept as
  -- given and matched by prefix.
  squash_sha text check (squash_sha is null or squash_sha ~ '^[0-9a-f]{7,64}$'),
  target_branch text check (
    target_branch is null or private.is_git_branch_name(target_branch)
  ),
  landed_at timestamptz,
  attached_at timestamptz not null default now(),
  attached_by text not null default private.current_user_entity_id()
    references public.profiles (id)
    check (public.is_entity_id_with_prefix(attached_by, 'usr')),
  primary key (card_id, repo, branch),
  -- An open branch has no landing; a landed one has all of it.
  constraint card_branches_landing_check check (
    case state
      when 'open' then
        squash_sha is null and target_branch is null and landed_at is null
      else
        squash_sha is not null and target_branch is not null
        and landed_at is not null
    end
  )
);

comment on table public.card_branches is
  'The git branches a card''s work ran on, open until one lands as a squash '
  'commit on its target. A record, never a gate: nothing here runs git.';

-- "Which branches are still open in this project": what a briefing names.
create index card_branches_open_idx
  on public.card_branches (scope)
  where state = 'open';

create index card_branches_attached_by_idx
  on public.card_branches (attached_by);

revoke all on public.card_branches from anon, authenticated;
grant select, insert, delete on public.card_branches to authenticated;
-- A landing is the only update: the row's identity (its card, scope, repo,
-- branch and author) never changes after it is recorded.
grant update (state, squash_sha, target_branch, landed_at)
  on public.card_branches to authenticated;
grant select, insert, update, delete on public.card_branches to service_role;

alter table public.card_branches enable row level security;

create policy "members read the branches of visible cards"
on public.card_branches
for select
to authenticated
using (
  scope = any (((select private.visible_scopes()))::extensions.ltree[])
);

-- The row's scope must be its CARD's scope. The foreign key alone accepts any
-- card id, so without this a writer of one scope could plant an open branch
-- on a card of another scope it may only read.
create policy "scope writers record branches as themselves"
on public.card_branches
for insert
to authenticated
with check (
  attached_by = (select private.current_user_entity_id())
  and private.can_write(scope)
  and exists (
    select 1
      from public.cards c
     where c.id = card_branches.card_id
       and c.scope operator(extensions.=) card_branches.scope
  )
);

create policy "scope writers land the branches of their scopes"
on public.card_branches
for update
to authenticated
using (private.can_write(scope))
with check (
  private.can_write(scope)
  and exists (
    select 1
      from public.cards c
     where c.id = card_branches.card_id
       and c.scope operator(extensions.=) card_branches.scope
  )
);

create policy "scope writers drop the branches of their scopes"
on public.card_branches
for delete
to authenticated
using (private.can_write(scope));

-- 3. the stream learns branches and landings ---------------------------------

alter table public.card_events
  add column branch_note text check (
    branch_note is null or length(btrim(branch_note)) between 1 and 500
  ),
  add column squash_sha text check (
    squash_sha is null or squash_sha ~ '^[0-9a-f]{7,64}$'
  ),
  add column target_branch text check (
    target_branch is null or private.is_git_branch_name(target_branch)
  );

comment on column public.card_events.branch_note is
  'What the mover declared in place of the branch rule: why work entering '
  'active has no code, or why an open branch leaving active has not landed.';

alter table public.card_events drop constraint card_events_type_check;
alter table public.card_events add constraint card_events_type_check check (
  type in ('created', 'edited', 'moved', 'archived',
           'attached', 'detached', 'noted', 'landed')
);

alter table public.card_events drop constraint card_events_ref_kind_check;
alter table public.card_events add constraint card_events_ref_kind_check check (
  ref_kind is null
  or ref_kind in ('memory', 'entity', 'thread', 'card', 'url', 'branch')
);

alter table public.card_events drop constraint card_events_shape_check;
alter table public.card_events add constraint card_events_shape_check check (
  case type
    when 'created' then to_state is not null and reason is null
    when 'edited' then revision is not null and reason is null
    when 'moved' then
      from_state is not null and to_state is not null
      and reason is not null and from_state <> to_state
    when 'archived' then reason is not null
    when 'attached' then ref_kind is not null and ref_target is not null
    when 'detached' then ref_kind is not null and ref_target is not null
    when 'noted' then note_text is not null
    when 'landed' then
      ref_kind = 'branch' and ref_target is not null
      and squash_sha is not null and target_branch is not null
    else false
  end
);

-- A declaration stands in for the branch rule, which only a card's opening
-- and its moves meet.
alter table public.card_events
  add constraint card_events_branch_note_placement_check check (
    branch_note is null or type in ('created', 'moved')
  );

-- 4. attach and detach route a branch to its own table -----------------------

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

-- 5. a card reads back with its branches -------------------------------------

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
             'attached_at', b.attached_at
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

-- 6. erasure -----------------------------------------------------------------

-- The account cascade gains card_branches. A branch someone recorded on
-- another member's card is theirs and leaves with them; their own cards take
-- the rest along the foreign key.
create or replace function public.hard_delete_user(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth uuid;
  v_mem text[];
  v_ent text[];
begin
  -- Resolve the auth principal. Null means the profile is already gone, which
  -- turns the rest of the body into a no-op sweep (idempotent second call).
  select user_id into v_auth from public.profiles where id = p_user_id;

  -- Capture the owned graph roots up front: transitive children are found by
  -- these id sets, and survivor back-references into them are severed below.
  select coalesce(array_agg(id), '{}') into v_mem
    from public.memories where owner_id = p_user_id;
  select coalesce(array_agg(id), '{}') into v_ent
    from public.entities where created_by = p_user_id;

  -- 1. Sever nullable references on SURVIVING rows (owned by others) that point
  --    at this user or at a memory about to be deleted. Nulling by `= any(v_mem)`
  --    also clears the user's own self-references, so deleting the memory set in
  --    one statement cannot trip the self-referential superseded_by FK.
  update public.memories set invalidated_by = null where invalidated_by = p_user_id;
  -- shared_by == owner_id (owner-only sharing), so restrict this to survivors:
  -- the departing user's OWN shared rows are deleted below and must keep
  -- shared_by until then, or memories_shared_lifecycle_check would abort here.
  update public.memories set shared_by = null
    where shared_by = p_user_id and owner_id <> p_user_id;
  update public.memories set superseded_by = null where superseded_by = any(v_mem);
  update public.edges set source_memory = null where source_memory = any(v_mem);
  update public.memory_review_queue set resolved_by = null where resolved_by = p_user_id;
  update public.memory_review_queue set winner = null where winner = any(v_mem);
  update public.reflection_candidates set resolved_by = null where resolved_by = p_user_id;
  update public.reflection_candidates set approved_memory_id = null
    where approved_memory_id = any(v_mem);
  update public.rule_candidates set resolved_by = null where resolved_by = p_user_id;
  -- A candidate adjudicated by this user may belong to someone else's memory
  -- and therefore survives the erasure; keep the row, drop the person.
  update public.portability_candidates set resolved_by = null
    where resolved_by = p_user_id;
  update public.scope_members set granted_by = null where granted_by = p_user_id;
  -- Anonymize the content-free command-bus log: keep the row, drop the link.
  update public.audit_log set actor_id = null where actor_id = p_user_id;

  -- 2. Delete transitive children of the user's graph, then the owned rows,
  --    children before parents.
  delete from public.roi_results
    where owner_id = p_user_id
       or probe_id in (select id from public.roi_probes where owner_id = p_user_id);
  delete from public.roi_probes
    where owner_id = p_user_id or source_memory_id = any(v_mem);
  delete from public.brief_probes
    where owner_id = p_user_id or memory_id = any(v_mem);
  delete from public.loop_closure_checks
    where loop_id = any(v_mem) or last_evidence_id = any(v_mem);
  delete from public.reflection_candidate_members
    where memory_id = any(v_mem)
       or candidate_id in
          (select id from public.reflection_candidates where owner_id = p_user_id);
  delete from public.reflection_candidates where owner_id = p_user_id;
  delete from public.rule_candidates where memory_id = any(v_mem);
  -- Owned by `owner_id`, so erased by owner rather than by the memory set:
  -- the `or memory_id = any(v_mem)` arm additionally clears candidates raised
  -- about this user's memories but recorded under another owner.
  delete from public.portability_candidates
    where owner_id = p_user_id or memory_id = any(v_mem);
  delete from public.memory_review_queue
    where memory_a = any(v_mem) or memory_b = any(v_mem);
  delete from public.memory_reinforcement where memory_id = any(v_mem);
  -- Transitive through memories, mirroring memory_reinforcement above.
  delete from public.memory_verification where memory_id = any(v_mem);
  -- Which judge model examined which memory: metadata about the memory, dies
  -- with it, exactly like the two ledgers above.
  delete from public.memory_judge_checks where memory_id = any(v_mem);
  delete from public.memory_entities
    where memory_id = any(v_mem) or entity_id = any(v_ent);
  delete from public.memory_links where src = any(v_mem) or dst = any(v_mem);
  delete from public.edges
    where created_by = p_user_id
       or src = any(v_ent) or dst = any(v_ent) or source_memory = any(v_mem);
  delete from public.entities where created_by = p_user_id;
  delete from public.memories where owner_id = p_user_id;

  -- Board rows: what this user wrote on OTHER people's cards first, then their
  -- own cards, which carry their remaining stream and attachments with them.
  delete from public.card_events where actor_id = p_user_id;
  -- A branch recorded on someone else's card is this user's record and
  -- leaves with them.
  delete from public.card_branches where attached_by = p_user_id;
  delete from public.card_refs where attached_by = p_user_id;
  delete from public.cards where created_by = p_user_id;

  -- Per-user operational and identity rows.
  delete from public.usage_events where user_id = p_user_id;
  delete from public.usage_daily where user_id = p_user_id;
  delete from public.ingest_log where user_id = p_user_id;
  delete from public.oauth_codes where user_id = p_user_id;
  delete from public.policy_allowances where subject_id = p_user_id;
  delete from public.provider_credentials where subject_id = p_user_id;
  delete from public.project_bindings where created_by = p_user_id;
  delete from public.scope_members where user_id = p_user_id;
  -- `scopes.created_by` is NO ACTION, so omitting it aborts the profile delete
  -- below — which is exactly how this line was almost lost when an earlier
  -- revision was drafted from an older one.
  delete from public.scopes where created_by = p_user_id;

  -- The user record, then the auth principal (a CASCADE from auth.users would
  -- also drop the profile; deleting it explicitly keeps the order legible).
  delete from public.profiles where id = p_user_id;
  if v_auth is not null then
    delete from auth.users where id = v_auth;
  end if;

  -- Erasure record: a content-free audit_log entry marking the deletion.
  insert into public.audit_log
    (id, occurred_at, actor_id, author_kind, agent_name, command, payload, outcome)
  values
    (public.entity_id_generate('aud'), now(), null, 'agent', 'account-lifecycle',
     'account.hard_delete',
     jsonb_build_object(
       'subject', p_user_id,
       'memories', coalesce(array_length(v_mem, 1), 0),
       'entities', coalesce(array_length(v_ent, 1), 0)),
     'ok');

  return jsonb_build_object(
    'subject', p_user_id,
    'auth_deleted', v_auth is not null,
    'memories', coalesce(array_length(v_mem, 1), 0),
    'entities', coalesce(array_length(v_ent, 1), 0));
end;
$$;

revoke all on function public.hard_delete_user(text) from public;
revoke all on function public.hard_delete_user(text) from anon, authenticated;
grant execute on function public.hard_delete_user(text) to service_role;
