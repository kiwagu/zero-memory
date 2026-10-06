-- Migration: deleting a user in Auth erases the account first
--
-- Purpose:
--   An operator can delete a user in Supabase Auth directly: the dashboard's
--   Delete button and the Auth admin API both do, and both are a plain delete
--   of the auth.users row. That row cascades into public.profiles, but every
--   other user column points at profiles with no action, because erasing a
--   person is more than a cascade: references on other people's rows are
--   severed, rows owned only through a memory go with it, the audit log keeps
--   its rows without the person, and a content-free record of the erasure is
--   written. So for any account that owned data the direct delete failed
--   ("Database error deleting user"), and only hard_delete_user could remove it.
--
--   The erasure body now lives in one function, private.erase_account, and
--   both ways in run it:
--     - a BEFORE DELETE trigger on auth.users, so a direct delete erases the
--       account first and then removes the auth row as asked;
--     - public.hard_delete_user, which erases and then deletes the auth row
--       (the trigger then finds no profile left and does nothing).
--   One body, so the two ways cannot drift apart.
--
-- Affected objects:
--   - function private.erase_account (new): the erasure body of
--     hard_delete_user as of its previous revision, without the auth delete
--   - function public.hard_delete_user (restated): erase, then delete the auth
--     principal; signature, grants and result unchanged
--   - function private.erase_account_before_auth_delete (new) and trigger
--     erase_account_before_delete on auth.users (new)
--
-- Special considerations:
--   - The trigger fires for every delete of an auth.users row, a hand-written
--     one included: an account never leaves without its data.
--   - The trigger must not call hard_delete_user: that deletes the very
--     auth.users row being deleted, which Postgres refuses from inside a
--     BEFORE trigger on that row.

-- 1. the erasure body -----------------------------------------------------------

-- Security invoker on purpose: it runs only inside the two definer entry points
-- below, as their owner, and nobody else is granted it.
create or replace function private.erase_account(p_user_id text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_mem text[];
  v_ent text[];
begin
  -- Erasure deletes relations and cards, so it takes the relation lock first,
  -- like every command that writes a relation: otherwise it could hold a
  -- relation row while an unlink holds that relation's cards, each waiting
  -- for the other.
  perform private.card_links_lock();

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
  -- The command-bus log keeps the row but neither the link to the person nor
  -- its payload: rows written before payloads became content-free may still
  -- carry words the person wrote.
  update public.audit_log
    set actor_id = null, payload = jsonb_build_object('erased', true)
    where actor_id = p_user_id;

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
  -- Through the revoke function, so the Vault secret goes with the row.
  perform public.revoke_provider_credential(p_user_id);
  delete from public.project_bindings where created_by = p_user_id;
  delete from public.scope_members where user_id = p_user_id;
  -- `scopes.created_by` is NO ACTION, so omitting it aborts the profile delete
  -- below — which is exactly how this line was almost lost when an earlier
  -- revision was drafted from an older one.
  delete from public.scopes where created_by = p_user_id;

  -- The user record. The auth principal is the caller's to remove: the
  -- trigger is already deleting it, and hard_delete_user deletes it next.
  delete from public.profiles where id = p_user_id;

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
    'memories', coalesce(array_length(v_mem, 1), 0),
    'entities', coalesce(array_length(v_ent, 1), 0));
end;
$$;

revoke all on function private.erase_account(text)
  from public, anon, authenticated, service_role;

-- 2. the RPC --------------------------------------------------------------------

create or replace function public.hard_delete_user(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth uuid;
  v_result jsonb;
begin
  -- Resolve the auth principal before the erasure removes the profile that
  -- names it. Null means the profile is already gone, and the erasure is a
  -- no-op sweep (idempotent second call).
  select user_id into v_auth from public.profiles where id = p_user_id;

  v_result := private.erase_account(p_user_id);

  -- Then the auth principal. Its delete trigger finds no profile left, so
  -- nothing is erased twice.
  if v_auth is not null then
    delete from auth.users where id = v_auth;
  end if;

  return v_result || jsonb_build_object('auth_deleted', v_auth is not null);
end;
$$;

revoke all on function public.hard_delete_user(text) from public;
revoke all on function public.hard_delete_user(text) from anon, authenticated;
grant execute on function public.hard_delete_user(text) to service_role;

-- 3. the direct delete ----------------------------------------------------------

-- Definer because Auth deletes as its own role, which has no rights on the
-- public tables the erasure writes. In `private`, so it is never a callable RPC;
-- the trigger runs it regardless of grants.
create or replace function private.erase_account_before_auth_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
begin
  select id into v_user_id from public.profiles where user_id = old.id;
  -- No profile: hard_delete_user has already erased the account and is now
  -- removing the auth row, or the account never had one. Nothing to erase.
  if v_user_id is not null then
    perform private.erase_account(v_user_id);
  end if;
  return old;
end;
$$;

revoke all on function private.erase_account_before_auth_delete()
  from public, anon, authenticated, service_role;

create trigger erase_account_before_delete
  before delete on auth.users
  for each row execute function private.erase_account_before_auth_delete();
