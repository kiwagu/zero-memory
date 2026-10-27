-- Migration: an account's judge — on or off, which provider, whose key
--
-- Purpose:
--   Standing rules can be delivered at a level a decision model picks per
--   call. Whether that runs for an account, on which provider, and on whose
--   key are the account's choices, made in the dashboard the way the model
--   provider key is: off by default; the platform's key unless the account
--   installs its own. An own key is kept in Vault, never readable back.
--
-- Affected objects:
--   - table public.judge_settings (new): enabled + provider per account
--   - table public.judge_credentials (new): reference to the Vault secret
--   - function public.set_judge_credential (new, server-only)
--   - function public.judge_credential_for (new, server-only)
--   - function public.revoke_judge_credential (new, server-only)
--   - function private.erase_account (restated): erasing an account also
--     removes its judge settings and its judge key
--
-- Special considerations:
--   - judge_settings holds no secret, so the owner reads and writes their own
--     row directly under RLS; the dashboard upserts it as the signed-in user.
--   - judge_credentials mirrors provider_credentials one for one (Vault
--     reference, four-character hint, definer functions as the only bridge).
--     It is a separate table because provider_credentials holds exactly one
--     key per subject and the model-provider key must stay untouched.
--   - The provider set is the same closed set the server code knows
--     ('typesafe', 'subq'); widening it is a code change and a migration.
--   - Both tables carry the restrictive "complete sessions only" policy that
--     every table under row-level security carries.
--   - Both tables are one account's data, and no foreign key cascades into
--     them, so the erasure body names them: the settings row is deleted and
--     the key is revoked through its function, which deletes the Vault secret
--     too. The rest of the body is the previous revision, unchanged.

set search_path = public, extensions;

-- 1. settings ----------------------------------------------------------------

create table public.judge_settings (
  subject_id text primary key
    check (public.is_entity_id_with_prefix(subject_id, 'usr')),
  enabled boolean not null default false,
  provider text
    check (provider is null or provider in ('typesafe', 'subq')),
  updated_at timestamptz not null default now()
);

comment on table public.judge_settings is
  'Per-account rule-gate choice: whether a decision model picks the delivery '
  'level of standing rules for this account, and which provider (null = the '
  'platform default). Off until the account turns it on.';

revoke all on public.judge_settings from anon, authenticated;
grant select, insert, update on public.judge_settings to authenticated;
grant select, insert, update, delete on public.judge_settings to service_role;

alter table public.judge_settings enable row level security;

create policy "judge settings are readable by their subject"
on public.judge_settings for select to authenticated
using (subject_id = (select private.current_user_entity_id()));

create policy "judge settings are written by their subject"
on public.judge_settings for insert to authenticated
with check (subject_id = (select private.current_user_entity_id()));

create policy "judge settings are updated by their subject"
on public.judge_settings for update to authenticated
using (subject_id = (select private.current_user_entity_id()))
with check (subject_id = (select private.current_user_entity_id()));

-- Like every table under row-level security: a session that has not completed
-- sign-in reaches nothing here, whatever the policies above admit.
create policy "complete sessions only"
on public.judge_settings
as restrictive
for all
to authenticated
using ((select private.session_complete()))
with check ((select private.session_complete()));

-- 2. credentials -------------------------------------------------------------

create table public.judge_credentials (
  subject_id text primary key
    check (public.is_entity_id_with_prefix(subject_id, 'usr')),
  provider text not null
    check (provider in ('typesafe', 'subq')),
  secret_id uuid not null,
  model text,
  hint text not null
    check (length(hint) <= 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.judge_credentials is
  'Per-account decision-model key for the rule gate. The key itself is in '
  'Vault; this row holds only its reference and display metadata. Readable '
  'by its owner (metadata only), written by nothing except the server.';

revoke all on public.judge_credentials from anon, authenticated;
grant select on public.judge_credentials to authenticated;
grant select, insert, update, delete on public.judge_credentials to service_role;

alter table public.judge_credentials enable row level security;

create policy "a judge credential is readable by its subject"
on public.judge_credentials for select to authenticated
using (subject_id = (select private.current_user_entity_id()));

-- Like every table under row-level security: a session that has not completed
-- sign-in reaches nothing here, whatever the policies above admit.
create policy "complete sessions only"
on public.judge_credentials
as restrictive
for all
to authenticated
using ((select private.session_complete()))
with check ((select private.session_complete()));

-- 3. write: store a key ------------------------------------------------------

create or replace function public.set_judge_credential(
  p_subject_id text,
  p_provider text,
  p_api_key text,
  p_model text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_secret_id uuid;
begin
  if p_api_key is null or length(trim(p_api_key)) < 8 then
    raise exception 'an api key is required';
  end if;

  select secret_id into v_existing
  from public.judge_credentials
  where subject_id = p_subject_id;

  if v_existing is null then
    v_secret_id := vault.create_secret(
      p_api_key,
      'judge_credential:' || p_subject_id,
      'Decision-model key supplied by the user'
    );
  else
    perform vault.update_secret(v_existing, p_api_key);
    v_secret_id := v_existing;
  end if;

  insert into public.judge_credentials
    (subject_id, provider, secret_id, model, hint, updated_at)
  values (p_subject_id, p_provider, v_secret_id, p_model, right(p_api_key, 4), now())
  on conflict (subject_id) do update set
    provider = excluded.provider,
    secret_id = excluded.secret_id,
    model = excluded.model,
    hint = excluded.hint,
    updated_at = now();
end;
$$;

-- 4. read: the server resolving whose key to use ------------------------------

create or replace function public.judge_credential_for(p_subject_id text)
returns table (provider text, model text, api_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.provider, c.model, s.decrypted_secret
  from public.judge_credentials c
  join vault.decrypted_secrets s on s.id = c.secret_id
  where c.subject_id = p_subject_id;
$$;

-- 5. revoke ------------------------------------------------------------------

create or replace function public.revoke_judge_credential(p_subject_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  delete from public.judge_credentials
  where subject_id = p_subject_id
  returning secret_id into v_secret_id;
  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;
end;
$$;

-- 6. lock the functions down ---------------------------------------------------

revoke all on function public.set_judge_credential(text, text, text, text)
  from anon, authenticated, public;
revoke all on function public.judge_credential_for(text)
  from anon, authenticated, public;
revoke all on function public.revoke_judge_credential(text)
  from anon, authenticated, public;

grant execute on function public.set_judge_credential(text, text, text, text)
  to service_role;
grant execute on function public.judge_credential_for(text) to service_role;
grant execute on function public.revoke_judge_credential(text) to service_role;

-- 7. erasure: the account's judge leaves with it -------------------------------

-- Security invoker on purpose: it runs only inside its two definer entry points
-- (public.hard_delete_user and the delete trigger on auth.users), as their
-- owner, and nobody else is granted it.
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
  -- The rule-gate choice, and the judge key through its revoke function so
  -- its Vault secret goes with the row, exactly as for the model-provider key.
  delete from public.judge_settings where subject_id = p_user_id;
  perform public.revoke_judge_credential(p_user_id);
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
