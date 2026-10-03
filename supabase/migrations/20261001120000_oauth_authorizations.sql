-- Migration: pending OAuth authorizations and stored consents
--
-- Purpose:
--   The authorization endpoint no longer renders its own password page. It
--   parks the validated request as a pending authorization and sends the
--   person to the dashboard, where they sign in any way the instance offers
--   and approve or deny the client. Approving records a consent, so the next
--   authorization of the same client by the same person needs no screen.
--
-- Affected objects:
--   - table: public.oauth_authorizations (RLS enabled, deny-all policy)
--   - table: public.oauth_consents       (RLS enabled, deny-all policy)
--   - function: public.hard_delete_user — erases both for a departing user
--
-- Special considerations:
--   - Server-only, like oauth_clients and oauth_codes: no grants to anon or
--     authenticated, an explicit deny-all policy for them, service_role only.
--     The dashboard reaches these rows exclusively through the authorization
--     server's endpoints, which check the caller's own session.
--   - An authorization binds to the FIRST signed-in person who opens it
--     (user_id null -> that user), and only that person can decide it. The
--     bind and the decision are single conditional updates in the adapter, so
--     two concurrent readers or deciders cannot both win.
--   - Pending rows are created before anyone signs in, so they carry no user
--     and expire after a short TTL; expired rows are swept opportunistically.
--   - The redirect URI stored here was already checked against the client's
--     registration when the row was created; the code is only ever delivered
--     to it.

-- 1. oauth_authorizations -------------------------------------------------------

create table public.oauth_authorizations (
  id text primary key default public.entity_id_generate('oaa')
    check (public.is_entity_id_with_prefix(id, 'oaa')),
  client_id text not null
    references public.oauth_clients (client_id) on delete cascade,
  -- The validated authorization request, replayed when the code is issued.
  redirect_uri text not null,
  code_challenge text not null,
  state text,
  -- RFC 8707 resource indicator (the MCP endpoint URL).
  resource text,
  scope text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied')),
  -- Null until the first signed-in reader opens it.
  user_id text references public.profiles (id) on delete cascade
    check (user_id is null or public.is_entity_id_with_prefix(user_id, 'usr')),
  expires_at timestamptz not null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  -- A decided row records when; a pending one has not been decided.
  constraint oauth_authorizations_decided_check
    check ((status = 'pending') = (decided_at is null))
);

comment on table public.oauth_authorizations is
  'Pending OAuth authorization requests awaiting the person''s decision on '
  'the dashboard consent screen (short TTL). Deny-all RLS: service-role '
  'access only, through the authorization server''s endpoints.';

-- Sweep of expired requests.
create index oauth_authorizations_expires_at_idx
  on public.oauth_authorizations
  using btree (expires_at);

-- Covering indexes for the foreign keys.
create index oauth_authorizations_client_id_idx
  on public.oauth_authorizations
  using btree (client_id);

create index oauth_authorizations_user_id_idx
  on public.oauth_authorizations
  using btree (user_id);

revoke all on public.oauth_authorizations from anon, authenticated;
grant select, insert, update, delete on public.oauth_authorizations to service_role;

alter table public.oauth_authorizations enable row level security;

create policy "server-only: deny all end-user access"
on public.oauth_authorizations
for all
to anon, authenticated
using (false)
with check (false);

-- 2. oauth_consents -------------------------------------------------------------

create table public.oauth_consents (
  user_id text not null references public.profiles (id) on delete cascade
    check (public.is_entity_id_with_prefix(user_id, 'usr')),
  client_id text not null
    references public.oauth_clients (client_id) on delete cascade,
  -- The scope the person approved; a later request for more asks again.
  scope text not null,
  granted_at timestamptz not null default now(),
  -- Set when the person withdraws the approval; the next request asks again.
  revoked_at timestamptz,
  primary key (user_id, client_id)
);

comment on table public.oauth_consents is
  'Which OAuth clients each person has approved, and for which scope. A live '
  'consent lets a repeat authorization of the same client skip the screen. '
  'Deny-all RLS: service-role access only.';

-- The primary key leads with user_id; client_id needs its own for the FK.
create index oauth_consents_client_id_idx
  on public.oauth_consents
  using btree (client_id);

revoke all on public.oauth_consents from anon, authenticated;
grant select, insert, update, delete on public.oauth_consents to service_role;

alter table public.oauth_consents enable row level security;

create policy "server-only: deny all end-user access"
on public.oauth_consents
for all
to anon, authenticated
using (false)
with check (false);

-- 3. erasure --------------------------------------------------------------------

-- Restated from the previous revision with the two tables added next to
-- oauth_codes; everything else is unchanged.
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
  -- Erasure deletes relations and cards, so it takes the relation lock first,
  -- like every command that writes a relation: otherwise it could hold a
  -- relation row while an unlink holds that relation's cards, each waiting
  -- for the other.
  perform private.card_links_lock();

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
  -- A relation this user stated is their record and leaves with them; one they
  -- only retired keeps its row, and loses the name of who retired it.
  delete from public.card_links where created_by = p_user_id;
  update public.card_links set invalidated_by = null
   where invalidated_by = p_user_id;
  delete from public.cards where created_by = p_user_id;

  -- A project's release setting and its observed states outlive the person
  -- who wrote them: the rows are the project's, only the authorship goes.
  update public.scope_release_settings
     set updated_by = null
   where updated_by = p_user_id;
  update public.scope_releases
     set observed_by = null
   where observed_by = p_user_id;

  -- Per-user operational and identity rows.
  delete from public.usage_events where user_id = p_user_id;
  delete from public.usage_daily where user_id = p_user_id;
  delete from public.ingest_log where user_id = p_user_id;
  delete from public.oauth_codes where user_id = p_user_id;
  -- A pending authorization this user opened and the clients they approved
  -- are their record; an unbound pending row (user_id null) belongs to nobody
  -- and simply expires.
  delete from public.oauth_authorizations where user_id = p_user_id;
  delete from public.oauth_consents where user_id = p_user_id;
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
