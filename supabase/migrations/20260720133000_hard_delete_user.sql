-- Migration: hard_delete_user — the account erasure cascade
--
-- Purpose:
--   There is no foreign key from any public table onto auth.users, so deleting
--   an auth principal would orphan every row it owns. This procedure is the
--   cascade the schema does not have: given a user's domain id (`usr_`,
--   public.profiles.id), it removes everything the account ownership map
--   (packages/db/src/ownership-map.ts) attributes to that user, severs the
--   nullable references surviving rows hold into the deleted data, anonymizes
--   the content-free audit trail, and finally removes the profile and the auth
--   principal — the complete erasure of an account's data.
--
--   The delete order mirrors the map's children-before-parents shape and is the
--   security-critical part: every table that references memories/entities/
--   profiles is cleared before the referenced rows go, so the cascade completes
--   without tripping a single foreign key. The e2e completeness guard proves
--   the order agrees with the map by asserting zero user rows remain in every
--   mapped table afterwards.
--
-- Affected objects:
--   - function public.hard_delete_user(text) (new, service_role only)
--
-- Special considerations:
--   - SECURITY DEFINER, rationale: the cascade spans every user's rows (past
--     RLS) and deletes the auth.users principal — privileges no end user holds.
--     Execute is granted to service_role only and revoked from everyone else;
--     this is a service-role entry point, never a self-serve one.
--   - Idempotent: a second call finds no profile, resolves a null auth id,
--     deletes zero rows everywhere, and still records an erasure entry. Safe to
--     retry after a partial failure (the whole body runs in the caller's
--     transaction — either all of it commits or none does).
--   - Back-references are severed, not deleted: a review another user resolved,
--     a membership they granted, a newer memory that superseded theirs — those
--     rows belong to other people; only the pointer to the departing user is
--     nulled. Shared content the user AUTHORED is deleted (the author's own
--     data; to be revisited once shared team scopes are exercised).
--   - The erasure record lives in the existing audit_log (content-free: the
--     subject id and counts only), with a null actor — a system action, not the
--     departing user's. No separate erasure log table.

set search_path = '';

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
  update public.memories set shared_by = null where shared_by = p_user_id;
  update public.memories set superseded_by = null where superseded_by = any(v_mem);
  update public.edges set source_memory = null where source_memory = any(v_mem);
  update public.memory_review_queue set resolved_by = null where resolved_by = p_user_id;
  update public.memory_review_queue set winner = null where winner = any(v_mem);
  update public.reflection_candidates set resolved_by = null where resolved_by = p_user_id;
  update public.reflection_candidates set approved_memory_id = null
    where approved_memory_id = any(v_mem);
  update public.rule_candidates set resolved_by = null where resolved_by = p_user_id;
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
  delete from public.memory_review_queue
    where memory_a = any(v_mem) or memory_b = any(v_mem);
  delete from public.memory_reinforcement where memory_id = any(v_mem);
  delete from public.memory_entities
    where memory_id = any(v_mem) or entity_id = any(v_ent);
  delete from public.memory_links where src = any(v_mem) or dst = any(v_mem);
  delete from public.edges
    where created_by = p_user_id
       or src = any(v_ent) or dst = any(v_ent) or source_memory = any(v_mem);
  delete from public.entities where created_by = p_user_id;
  delete from public.memories where owner_id = p_user_id;

  -- Per-user operational and identity rows.
  delete from public.usage_events where user_id = p_user_id;
  delete from public.usage_daily where user_id = p_user_id;
  delete from public.ingest_log where user_id = p_user_id;
  delete from public.oauth_codes where user_id = p_user_id;
  delete from public.policy_allowances where subject_id = p_user_id;
  delete from public.provider_credentials where subject_id = p_user_id;
  delete from public.project_bindings where created_by = p_user_id;
  delete from public.scope_members where user_id = p_user_id;

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

comment on function public.hard_delete_user(text) is
  'Account erasure cascade over the ownership map: deletes everything owned by '
  'the given usr_ id, severs surviving back-references, anonymizes the audit '
  'trail, and removes the profile and auth principal. Idempotent. service_role '
  'only.';

revoke all on function public.hard_delete_user(text) from public;
revoke all on function public.hard_delete_user(text) from anon, authenticated;
grant execute on function public.hard_delete_user(text) to service_role;
