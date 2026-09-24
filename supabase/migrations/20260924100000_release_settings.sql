-- Migration: a project states where its production state lives, and the
-- states it went through are kept
--
-- Purpose:
--   A card records where its work landed; nothing recorded where that work
--   went next. A project now names the source of its production state — a
--   url that answers the running version, or, for a project that never
--   deploys, its release tags — and every state observed there is kept, with
--   the release it resolved to. A card gains a `released` event for each
--   state that carries its landing.
--
-- Affected objects:
--   - function private.is_release_url (new)
--   - table public.scope_release_settings (new)
--   - table public.scope_releases (new)
--   - table public.card_events: release_version, release_build,
--     release_commit; type `released`
--   - function public.hard_delete_user: severs the new author columns
--
-- Special considerations:
--   - The url is read by the CLIENT watcher, never by the server: the server
--     makes no request to an address a user gave it. The check below keeps
--     the url free of credentials all the same, since every member of the
--     project can read it.
--   - The release commands are the way in, but the policies are the fence:
--     a project's admin may write its setting directly, and any writer of
--     the project may report a state directly. A state's first observation
--     is never rewritten; seeing it again moves only its last sighting, so a
--     state production returns to is current again.

set search_path = public, extensions;

-- 1. the url a project may name ----------------------------------------------

create or replace function private.is_release_url(p_url text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_url is not null
     and length(p_url) <= 500
     and p_url !~ '\s'
     and (
       p_url ~ '^https://[^/@?#]+(/[^@]*)?$'
       or p_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/[^@]*)?$'
     );
$$;

revoke all on function private.is_release_url(text) from public, anon;
grant execute on function private.is_release_url(text)
  to authenticated, service_role;

-- 2. the setting ---------------------------------------------------------------

create table public.scope_release_settings (
  scope extensions.ltree primary key,
  version_url text check (
    version_url is null or private.is_release_url(version_url)
  ),
  version_field text not null default 'version' check (
    version_field ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,4}$'
  ),
  -- How a version becomes its tag. The tag is written into every member's
  -- session line (the missing-tag hint names the command to run), so the
  -- template holds {version} once and otherwise only characters a git ref may
  -- hold, and it cannot start like an option.
  tag_template text not null default 'v{version}' check (
    length(tag_template) <= 100
    and tag_template ~ '^([A-Za-z0-9._/@+][A-Za-z0-9._/@+-]*)?\{version\}[A-Za-z0-9._/@+-]*$'
  ),
  tag_pattern text not null default 'v*' check (
    length(tag_pattern) between 1 and 100 and tag_pattern !~ '\s'
    and left(tag_pattern, 1) <> '-'
  ),
  on_release text not null default 'record' check (
    on_release in ('record', 'record_and_move_done')
  ),
  -- Nullable: erasure severs the author and keeps the setting.
  updated_by text default private.current_user_entity_id()
    references public.profiles (id)
    check (updated_by is null or public.is_entity_id_with_prefix(updated_by, 'usr')),
  updated_at timestamptz not null default now()
);

comment on table public.scope_release_settings is
  'Where a project''s production state lives: a url answering the running '
  'version, or its release tags. Read by the client watcher, never fetched by '
  'the server.';

revoke all on public.scope_release_settings from anon, authenticated;
grant select, insert, update on public.scope_release_settings to authenticated;
grant select, insert, update, delete on public.scope_release_settings
  to service_role;

alter table public.scope_release_settings enable row level security;

create policy "members read their projects' release settings"
on public.scope_release_settings
for select
to authenticated
using (scope = any (((select private.visible_scopes()))::extensions.ltree[]));

-- Where production lives decides which cards get marked, and the url is read
-- by every member's watcher: only the project's admin sets it.
create policy "project admins set where production lives"
on public.scope_release_settings
for insert
to authenticated
with check (
  private.is_scope_admin(scope)
  and updated_by = (select private.current_user_entity_id())
);

create policy "project admins change where production lives"
on public.scope_release_settings
for update
to authenticated
using (private.is_scope_admin(scope))
with check (
  private.is_scope_admin(scope)
  and updated_by = (select private.current_user_entity_id())
);

-- 3. the states observed ---------------------------------------------------------

create table public.scope_releases (
  scope extensions.ltree not null,
  version text not null check (version ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$'),
  build text check (build is null or build ~ '^[0-9A-Za-z._-]{1,64}$'),
  release_commit text not null check (release_commit ~ '^[0-9a-f]{7,64}$'),
  source text not null check (source in ('url', 'tag')),
  observed_at timestamptz not null default now(),
  -- Moves each time the state is seen again: a rollback to an earlier
  -- version makes that version current again.
  last_observed_at timestamptz not null default now(),
  observed_by text default private.current_user_entity_id()
    references public.profiles (id)
    check (observed_by is null or public.is_entity_id_with_prefix(observed_by, 'usr')),
  primary key (scope, version)
);

comment on table public.scope_releases is
  'Every production state a project was seen in, first observer first. The '
  'release commit is what the state resolved to in the observer''s checkout; '
  'last_observed_at is when the state was last seen, so the latest sighting '
  'names what production runs now.';

create index scope_releases_latest_idx
  on public.scope_releases (scope, last_observed_at desc);

revoke all on public.scope_releases from anon, authenticated;
grant select, insert on public.scope_releases to authenticated;
-- The last sighting is the one column a writer may move.
grant update (last_observed_at) on public.scope_releases to authenticated;
grant select, insert, update, delete on public.scope_releases to service_role;

alter table public.scope_releases enable row level security;

create policy "members read their projects' releases"
on public.scope_releases
for select
to authenticated
using (scope = any (((select private.visible_scopes()))::extensions.ltree[]));

-- A state's first observation is never rewritten: the column grant above
-- lets an update move only last_observed_at, and there is no delete policy.
create policy "project writers report the production state they saw"
on public.scope_releases
for insert
to authenticated
with check (
  private.can_write(scope)
  and observed_by = (select private.current_user_entity_id())
);

create policy "project writers report a production state seen again"
on public.scope_releases
for update
to authenticated
using (private.can_write(scope))
with check (private.can_write(scope));

-- 4. a card learns its releases ----------------------------------------------------

alter table public.card_events
  add column release_version text check (
    release_version is null or release_version ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$'
  ),
  add column release_build text check (
    release_build is null or release_build ~ '^[0-9A-Za-z._-]{1,64}$'
  ),
  add column release_commit text check (
    release_commit is null or release_commit ~ '^[0-9a-f]{7,64}$'
  );

alter table public.card_events drop constraint card_events_type_check;
alter table public.card_events add constraint card_events_type_check check (
  type in ('created', 'edited', 'moved', 'archived',
           'attached', 'detached', 'noted', 'landed', 'released')
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
    when 'released' then
      release_version is not null and release_commit is not null
    else false
  end
);

-- One release record per card and version, however many observers report it.
create unique index card_events_one_release_per_version
  on public.card_events (card_id, release_version)
  where type = 'released';

-- 5. erasure -------------------------------------------------------------------

-- The account cascade severs the author of a release setting and the observer
-- of a production state; both rows belong to the project and stay.
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
