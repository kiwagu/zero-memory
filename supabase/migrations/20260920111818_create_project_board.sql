-- Migration: the project board — cards, their event stream, and attachments
--
-- Purpose:
--   A card is the container of one piece of work: what is being done, where it
--   stands, and the artifacts it is made of. It sits between an open loop (a
--   pointer that ages out in days) and a memory (one atomic fact that lives for
--   months) — work that runs for weeks had no home before it.
--
--   The board is a REFERENCE, never an engine. A card's state is a declaration
--   by whoever moved it; nothing here dispatches, claims, leases or blocks work,
--   and no state is a precondition for any operation on this schema.
--
-- Affected objects:
--   - table: public.cards        (+ RLS policies)
--   - table: public.card_events  (+ RLS policies)
--   - table: public.card_refs    (+ RLS policies)
--   - function: public.hard_delete_user(text) (create or replace: the three new
--     tables join the erasure cascade)
--
-- Special considerations:
--   - EVERY MOVE CARRIES A REASON. `card_events` refuses a `moved` or
--     `archived` row whose reason is blank — the check is in the schema, not
--     only in the application, because an unexplained transition is the one
--     thing the board must never contain.
--   - Cards are SHARED IN THEIR SCOPE and carry no per-card visibility column.
--     The card is an inter-agent space; a private card would defeat it, and the
--     blast radius is already bounded by the scope fences (per-owner project
--     roots, membership by consent, visible_scopes/can_write). Everything
--     written into a card is therefore visible to the scope's members, which
--     the write tools state plainly.
--   - `scope` is denormalized onto the child tables so every policy is the same
--     one-predicate test rather than a per-row subquery against the parent. A
--     card never changes scope, so the copy cannot drift.
--   - Attachments carry no foreign key: their targets are polymorphic and some
--     (a url) are external. A target is authorized per viewer when the feed is
--     read, and one the viewer may not read renders as an id-only stub — so a
--     dangling or invisible target is an expected state, not a defect.
--   - Detaching DELETES the live row: the event stream is the history, and a
--     reference is not knowledge. The ADD-only discipline governs memories.

-- Keep ltree resolvable while this migration file runs. Session-level `set`
-- (not `set local`): the CLI applies statements outside a transaction block.
set search_path = public, extensions;

-- 1. cards --------------------------------------------------------------------

create table public.cards (
  id text primary key default public.entity_id_generate('crd')
    check (public.is_entity_id_with_prefix(id, 'crd')),
  scope extensions.ltree not null,
  -- Project-local address (`#42`). Allocated as max+1 within the scope, so an
  -- archived card's number is never handed to a later one.
  number integer not null check (number > 0),
  title text not null check (
    length(btrim(title)) between 1 and 200
  ),
  body text not null default '' check (length(body) <= 8000),
  state text not null default 'idea' check (
    state in ('idea', 'active', 'waiting', 'done', 'parked')
  ),
  -- Bumped by every content edit; an edit may name the revision it expects.
  revision integer not null default 1 check (revision > 0),
  -- The open loop this card was promoted from, when it was. `set null` on
  -- delete: erasing the loop must not take the work with it.
  origin_loop_id text references public.memories (id) on delete set null
    check (origin_loop_id is null
           or public.is_entity_id_with_prefix(origin_loop_id, 'mem')),
  -- Makes a retried create land once within the scope.
  idempotency_key text check (
    idempotency_key is null or length(btrim(idempotency_key)) between 1 and 200
  ),
  created_by text not null default private.current_user_entity_id()
    references public.profiles (id)
    check (public.is_entity_id_with_prefix(created_by, 'usr')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Set when the card leaves the board. Terminal: an archived card is
  -- read-only. Reversible shelving is the `parked` state, which stays visible.
  archived_at timestamptz,
  unique (scope, number)
);

comment on table public.cards is
  'Project board card: the container of one piece of work. Its state is a '
  'declaration, never a precondition — nothing in this schema dispatches or '
  'gates work by it.';

create unique index cards_scope_idempotency_key_idx
  on public.cards (scope, idempotency_key)
  where idempotency_key is not null;

create index cards_scope_state_idx
  on public.cards (scope, state)
  where archived_at is null;

create index cards_created_by_idx on public.cards (created_by);

-- Unique, not merely indexed: a loop promotes into exactly ONE card, so a
-- repeated promote finds the first card instead of forking the work.
create unique index cards_origin_loop_idx
  on public.cards (origin_loop_id)
  where origin_loop_id is not null;

-- 2. card_events --------------------------------------------------------------

create table public.card_events (
  id text primary key default public.entity_id_generate('cev')
    check (public.is_entity_id_with_prefix(id, 'cev')),
  card_id text not null references public.cards (id) on delete cascade,
  scope extensions.ltree not null,
  -- Position in this card's own stream. Allocated under the card's row lock.
  seq bigint not null check (seq > 0),
  type text not null check (
    type in ('created', 'edited', 'moved', 'archived',
             'attached', 'detached', 'noted')
  ),
  actor_id text not null default private.current_user_entity_id()
    references public.profiles (id)
    check (public.is_entity_id_with_prefix(actor_id, 'usr')),
  -- The name the author declares for itself: metadata for the reader. Authority
  -- comes from actor_id, never from this.
  agent_label text check (
    agent_label is null or length(btrim(agent_label)) between 1 and 80
  ),
  -- The conversation the event was written in, when one was asserted.
  thread text check (
    thread is null or public.is_entity_id_with_prefix(thread, 'thr')
  ),
  from_state text check (
    from_state is null
    or from_state in ('idea', 'active', 'waiting', 'done', 'parked')
  ),
  to_state text check (
    to_state is null
    or to_state in ('idea', 'active', 'waiting', 'done', 'parked')
  ),
  reason text check (
    reason is null or length(btrim(reason)) between 1 and 500
  ),
  revision integer check (revision is null or revision > 0),
  note_text text check (
    note_text is null or length(btrim(note_text)) between 1 and 4000
  ),
  reply_to text references public.card_events (id) on delete set null,
  relation text check (
    relation is null or relation in ('supports', 'disputes', 'corrects')
  ),
  ref_kind text check (
    ref_kind is null
    or ref_kind in ('memory', 'entity', 'thread', 'card', 'url')
  ),
  ref_target text check (
    ref_target is null or length(ref_target) between 1 and 2048
  ),
  idempotency_key text check (
    idempotency_key is null or length(btrim(idempotency_key)) between 1 and 200
  ),
  created_at timestamptz not null default now(),
  unique (card_id, seq),
  -- Per-type shape. A `moved` row without a reason is unrepresentable here, not
  -- merely discouraged upstream; the same for a note with no text and an
  -- attachment with no target.
  constraint card_events_shape_check check (
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
      else false
    end
  ),
  -- A relation says how a note stands to the one it answers; without that note
  -- it says nothing.
  constraint card_events_relation_needs_reply_check check (
    relation is null or reply_to is not null
  )
);

comment on table public.card_events is
  'Append-only stream of one card: moves with their reason, attachments, and '
  'author notes. A note is its author''s statement, never a fact or a command '
  '— text claiming work is finished does not move the card.';

create index card_events_card_seq_idx on public.card_events (card_id, seq desc);

create unique index card_events_idempotency_key_idx
  on public.card_events (card_id, idempotency_key)
  where idempotency_key is not null;

create index card_events_actor_idx on public.card_events (actor_id);

-- Serves the derived feed: memories born in a bound conversation appear on the
-- card without anyone attaching them one by one.
create index card_events_thread_idx
  on public.card_events (thread)
  where thread is not null;

-- 3. card_refs ----------------------------------------------------------------

create table public.card_refs (
  card_id text not null references public.cards (id) on delete cascade,
  scope extensions.ltree not null,
  kind text not null check (
    kind in ('memory', 'entity', 'thread', 'card', 'url')
  ),
  target text not null check (length(target) between 1 and 2048),
  attached_at timestamptz not null default now(),
  attached_by text not null default private.current_user_entity_id()
    references public.profiles (id)
    check (public.is_entity_id_with_prefix(attached_by, 'usr')),
  primary key (card_id, kind, target)
);

comment on table public.card_refs is
  'Live attachments of a card. Attaching changes nothing about the target — '
  'not its scope, not its visibility, not an open loop''s lifecycle. There is '
  'deliberately no `loop` kind: a loop IS a memory and attaches as one.';

-- "Which cards point at this memory" — the lookup behind a memory showing the
-- card it belongs to.
create index card_refs_target_idx on public.card_refs (kind, target);

-- 4. grants -------------------------------------------------------------------

revoke all on public.cards from anon, authenticated;
grant select, insert, update on public.cards to authenticated;
grant select, insert, update, delete on public.cards to service_role;

revoke all on public.card_events from anon, authenticated;
grant select, insert on public.card_events to authenticated;
grant select, insert, update, delete on public.card_events to service_role;

revoke all on public.card_refs from anon, authenticated;
grant select, insert, delete on public.card_refs to authenticated;
grant select, insert, update, delete on public.card_refs to service_role;

-- 5. RLS ----------------------------------------------------------------------

alter table public.cards enable row level security;
alter table public.card_events enable row level security;
alter table public.card_refs enable row level security;

-- Fail-closed baseline: anon has no policies and therefore sees nothing.

create policy "members read the cards of their scopes"
on public.cards
for select
to authenticated
using (
  scope = any (((select private.visible_scopes()))::extensions.ltree[])
);

create policy "scope writers open cards as themselves"
on public.cards
for insert
to authenticated
with check (
  created_by = (select private.current_user_entity_id())
  and private.can_write(scope)
);

create policy "scope writers update the cards of their scopes"
on public.cards
for update
to authenticated
using (private.can_write(scope))
with check (private.can_write(scope));

-- Deliberately NO delete policy: a card leaves the board by being archived,
-- which keeps its number spent and its history readable.

create policy "members read the stream of visible cards"
on public.card_events
for select
to authenticated
using (
  scope = any (((select private.visible_scopes()))::extensions.ltree[])
);

create policy "scope writers append to the stream as themselves"
on public.card_events
for insert
to authenticated
with check (
  actor_id = (select private.current_user_entity_id())
  and private.can_write(scope)
);

-- No update and no delete policy: the stream is append-only. A correction is a
-- new note pointing at the one it corrects.

create policy "members read the attachments of visible cards"
on public.card_refs
for select
to authenticated
using (
  scope = any (((select private.visible_scopes()))::extensions.ltree[])
);

create policy "scope writers attach as themselves"
on public.card_refs
for insert
to authenticated
with check (
  attached_by = (select private.current_user_entity_id())
  and private.can_write(scope)
);

create policy "scope writers detach within their scopes"
on public.card_refs
for delete
to authenticated
using (private.can_write(scope));

-- 6. erasure ------------------------------------------------------------------

-- The account cascade gains the three board tables. Order matters and mirrors
-- the ownership map: a departing member's events and attachments on cards that
-- SURVIVE (someone else's cards in a shared scope) go first, then their own
-- cards, whose foreign keys carry the rest away.
--
-- `cards.origin_loop_id` and `card_events.reply_to` are both `on delete set
-- null`, so neither a deleted memory nor a deleted note can abort the sweep.
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
