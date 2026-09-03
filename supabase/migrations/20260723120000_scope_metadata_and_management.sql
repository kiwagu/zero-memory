-- Migration: scope metadata (alias + description) and admin management RPCs
--
-- Purpose:
--   Scopes so far existed only implicitly (ltree paths on rows + membership
--   in scope_members). The dashboard needs them as first-class objects:
--     - a human-friendly ALIAS (per-owner ltree paths are long and unreadable
--       in cards and filter dropdowns);
--     - an optional DESCRIPTION (filled by a person or by the model);
--     - admin controls: RENAME (slug change), MERGE (pour one scope into
--       another), DELETE (with all associated rows).
--
-- Affected objects:
--   - table: public.scopes (new) + RLS + grants
--   - function: public.list_memory_scopes (drop + recreate; now returns alias)
--   - functions: public.rename_scope, public.merge_scopes, public.delete_scope
--     (new, SECURITY DEFINER, admin-gated, revoked from public/anon)
--
-- Special considerations:
--   - The management functions are SECURITY DEFINER because they must move or
--     delete rows across members' data (RLS on memories only lets an owner
--     touch their own rows). Every function re-checks admin membership via
--     private.is_scope_admin and refuses non-shareable roots, so the definer
--     power is gated exactly like scope administration elsewhere.
--   - All three operate on the whole SUBTREE of the target scope, re-pathing
--     descendants consistently.
--   - delete_scope hard-deletes; the deletion order mirrors hard_delete_user
--     (all referrers first). External superseded_by references INTO the
--     deleted set are nulled, not cascaded.
--   - merge_scopes resolves entity collisions on unique(normalized_name,
--     type, scope) by re-pointing memory_entities/edges to the surviving
--     entity and dropping the duplicate (the merge_entities approach).

set search_path = public, extensions;

-- 1. scopes metadata table ---------------------------------------------------

create table public.scopes (
  scope extensions.ltree primary key,
  alias text check (alias is null or char_length(alias) between 1 and 64),
  description text check (
    description is null or char_length(description) <= 2000
  ),
  -- Who authored the current description: a person or the model.
  description_source text check (
    description_source is null or description_source in ('human', 'model')
  ),
  created_by text not null default private.current_user_entity_id()
    references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.scopes is
  'Display metadata of shared scopes: alias (short name for cards/filters) '
  'and optional description (human- or model-written). The scope itself '
  'lives as ltree paths on rows + scope_members; this table only decorates.';

alter table public.scopes enable row level security;

revoke all on public.scopes from anon, authenticated;
grant select, insert, update, delete on public.scopes to authenticated;
grant all on public.scopes to service_role;

-- Readable exactly where the scope's shared memories are readable.
create policy scopes_select on public.scopes
  for select to authenticated
  using (scope operator(extensions.=) any (private.visible_scopes()));

-- Metadata writes are a scope-admin act.
create policy scopes_insert on public.scopes
  for insert to authenticated
  with check ((select private.is_scope_admin(scope)));

create policy scopes_update on public.scopes
  for update to authenticated
  using ((select private.is_scope_admin(scope)))
  with check ((select private.is_scope_admin(scope)));

create policy scopes_delete on public.scopes
  for delete to authenticated
  using ((select private.is_scope_admin(scope)));

-- 2. list_memory_scopes: carry the alias -------------------------------------

drop function if exists public.list_memory_scopes();

create or replace function public.list_memory_scopes()
returns table (scope text, alias text)
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct
    m.scope::text as scope,
    s.alias
  from public.memories m
  left join public.scopes s
    on s.scope operator(extensions.=) m.scope
  where m.invalidated_at is null
  order by 1;
$$;

comment on function public.list_memory_scopes() is
  'Distinct scopes of the caller''s visible active memories (RLS applies), '
  'with the display alias when one is set. Feeds the Memories scope filter.';

revoke all on function public.list_memory_scopes() from public, anon;
grant execute on function public.list_memory_scopes() to authenticated;

-- 3. shared guard for the management functions --------------------------------

-- Admin-gated, shareable-root-only entry check. Raises on violation so every
-- management function fails closed with a readable message.
create or replace function private.assert_scope_manageable(
  p_scope extensions.ltree
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if extensions.nlevel(p_scope) < 2
     or extensions.subpath(p_scope, 0, 1)::text not in ('proj', 'team') then
    raise exception 'scope % is not a manageable shared scope', p_scope
      using errcode = 'check_violation';
  end if;
  if not private.is_scope_admin(p_scope) then
    raise exception 'not an admin of scope %', p_scope
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

revoke all on function private.assert_scope_manageable(extensions.ltree)
  from public, anon;
grant execute on function private.assert_scope_manageable(extensions.ltree)
  to authenticated, service_role;

-- Re-path one ltree from under p_old to under p_new. subpath(x, nlevel(x))
-- raises "invalid positions", so the exact-root case is special-cased.
create or replace function private.scope_repath(
  p_path extensions.ltree,
  p_old extensions.ltree,
  p_new extensions.ltree
)
returns extensions.ltree
language sql
immutable
set search_path = ''
as $$
  select case
    when extensions.nlevel(p_path) = extensions.nlevel(p_old) then p_new
    else p_new operator(extensions.||)
      extensions.subpath(p_path, extensions.nlevel(p_old))
  end;
$$;

revoke all on function private.scope_repath(
  extensions.ltree, extensions.ltree, extensions.ltree
) from public, anon;
grant execute on function private.scope_repath(
  extensions.ltree, extensions.ltree, extensions.ltree
) to authenticated, service_role;

-- 4. rename_scope -------------------------------------------------------------

create or replace function public.rename_scope(
  p_scope extensions.ltree,
  p_new_slug text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent extensions.ltree;
  v_target extensions.ltree;
begin
  perform private.assert_scope_manageable(p_scope);

  if p_new_slug !~ '^[a-z0-9_]{1,63}$' then
    raise exception 'invalid slug "%": expected [a-z0-9_]', p_new_slug
      using errcode = 'check_violation';
  end if;

  v_parent := extensions.subpath(p_scope, 0, extensions.nlevel(p_scope) - 1);
  v_target := (v_parent::text || '.' || p_new_slug)::extensions.ltree;
  if v_target operator(extensions.=) p_scope then
    return p_scope::text;
  end if;

  -- The target name must be free everywhere (rename never merges).
  if exists (
      select 1 from public.memories
      where scope operator(extensions.<@) v_target
    )
    or exists (
      select 1 from public.entities
      where scope operator(extensions.<@) v_target
    )
    or exists (
      select 1 from public.scope_members
      where scope operator(extensions.<@) v_target
    )
    or exists (
      select 1 from public.scopes
      where scope operator(extensions.<@) v_target
    ) then
    raise exception 'target scope % already exists', v_target
      using errcode = 'unique_violation';
  end if;

  -- Re-path the whole subtree consistently across every scope-carrying table.
  update public.memories set scope =
      private.scope_repath(scope, p_scope, v_target)
    where scope operator(extensions.<@) p_scope;
  update public.entities set scope =
      private.scope_repath(scope, p_scope, v_target)
    where scope operator(extensions.<@) p_scope;
  update public.edges set scope =
      private.scope_repath(scope, p_scope, v_target)
    where scope operator(extensions.<@) p_scope;
  update public.reflection_candidates set scope =
      private.scope_repath(scope, p_scope, v_target)
    where scope operator(extensions.<@) p_scope;
  update public.project_bindings set scope =
      private.scope_repath(scope, p_scope, v_target)
    where scope operator(extensions.<@) p_scope;
  update public.scope_members set scope =
      private.scope_repath(scope, p_scope, v_target)
    where scope operator(extensions.<@) p_scope;
  update public.scopes set
      scope = private.scope_repath(scope, p_scope, v_target),
      updated_at = now()
    where scope operator(extensions.<@) p_scope;

  return v_target::text;
end;
$$;

comment on function public.rename_scope(extensions.ltree, text) is
  'Renames a shared scope''s slug (last label), re-pathing the whole subtree '
  'across memories, entities, edges, members, bindings and metadata. Admin '
  'only; the target name must be free. SECURITY DEFINER with explicit gate.';

revoke all on function public.rename_scope(extensions.ltree, text)
  from public, anon;
grant execute on function public.rename_scope(extensions.ltree, text)
  to authenticated, service_role;

-- 5. merge_scopes --------------------------------------------------------------

create or replace function public.merge_scopes(
  p_from extensions.ltree,
  p_into extensions.ltree
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_memories int;
  v_entities int;
  v_members int;
begin
  perform private.assert_scope_manageable(p_from);
  perform private.assert_scope_manageable(p_into);

  if p_from operator(extensions.<@) p_into
     or p_into operator(extensions.<@) p_from then
    raise exception 'cannot merge % into %: one contains the other',
      p_from, p_into using errcode = 'check_violation';
  end if;

  -- Entities colliding on unique(normalized_name, type, scope): re-point
  -- referrers to the surviving target-scope entity, then drop the duplicate.
  create temp table _merge_dups on commit drop as
    select d.id as dup_id, s.id as survivor_id
    from public.entities d
    join public.entities s
      on s.normalized_name = d.normalized_name
     and s.type = d.type
     and s.scope operator(extensions.=)
       private.scope_repath(d.scope, p_from, p_into)
    where d.scope operator(extensions.<@) p_from;

  insert into public.memory_entities (memory_id, entity_id)
    select me.memory_id, dup.survivor_id
    from public.memory_entities me
    join _merge_dups dup on dup.dup_id = me.entity_id
  on conflict do nothing;
  delete from public.memory_entities me
    using _merge_dups dup where dup.dup_id = me.entity_id;

  update public.edges e set src = dup.survivor_id
    from _merge_dups dup where e.src = dup.dup_id;
  update public.edges e set dst = dup.survivor_id
    from _merge_dups dup where e.dst = dup.dup_id;

  delete from public.entities e
    using _merge_dups dup where e.id = dup.dup_id;
  get diagnostics v_entities = row_count;

  -- Move everything else into the target subtree.
  update public.entities set scope =
      private.scope_repath(scope, p_from, p_into)
    where scope operator(extensions.<@) p_from;
  update public.memories set scope =
      private.scope_repath(scope, p_from, p_into)
    where scope operator(extensions.<@) p_from;
  get diagnostics v_memories = row_count;
  update public.edges set scope =
      private.scope_repath(scope, p_from, p_into)
    where scope operator(extensions.<@) p_from;
  update public.reflection_candidates set scope =
      private.scope_repath(scope, p_from, p_into)
    where scope operator(extensions.<@) p_from;
  update public.project_bindings set scope =
      private.scope_repath(scope, p_from, p_into)
    where scope operator(extensions.<@) p_from;

  -- Membership union: keep existing target roles, add missing members.
  insert into public.scope_members (scope, user_id, role, granted_by)
    select
      private.scope_repath(sm.scope, p_from, p_into),
      sm.user_id, sm.role, sm.granted_by
    from public.scope_members sm
    where sm.scope operator(extensions.<@) p_from
  on conflict do nothing;
  delete from public.scope_members
    where scope operator(extensions.<@) p_from;
  get diagnostics v_members = row_count;

  -- Target keeps its own metadata; the source's is retired with it.
  delete from public.scopes where scope operator(extensions.<@) p_from;

  return jsonb_build_object(
    'memories_moved', v_memories,
    'entities_deduped', v_entities,
    'members_folded', v_members
  );
end;
$$;

comment on function public.merge_scopes(extensions.ltree, extensions.ltree) is
  'Pours one shared scope (subtree) into another: moves memories/entities/'
  'edges/bindings, de-dupes colliding entities onto the survivors, unions '
  'membership, drops the source metadata. Admin on BOTH scopes required.';

revoke all on function public.merge_scopes(extensions.ltree, extensions.ltree)
  from public, anon;
grant execute on function public.merge_scopes(
  extensions.ltree, extensions.ltree
) to authenticated, service_role;

-- 6. delete_scope --------------------------------------------------------------

create or replace function public.delete_scope(p_scope extensions.ltree)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mem text[];
  v_memories int;
begin
  perform private.assert_scope_manageable(p_scope);

  select coalesce(array_agg(id), '{}') into v_mem
    from public.memories where scope operator(extensions.<@) p_scope;
  v_memories := coalesce(array_length(v_mem, 1), 0);

  -- Referrers first (mirrors hard_delete_user's ordering).
  delete from public.roi_results where probe_id in (
    select id from public.roi_probes where source_memory_id = any(v_mem));
  delete from public.roi_probes where source_memory_id = any(v_mem);
  delete from public.brief_probes where memory_id = any(v_mem);
  delete from public.loop_closure_checks
    where loop_id = any(v_mem) or last_evidence_id = any(v_mem);
  delete from public.reflection_candidate_members
    where memory_id = any(v_mem) or candidate_id in (
      select id from public.reflection_candidates
      where scope operator(extensions.<@) p_scope);
  delete from public.reflection_candidates
    where scope operator(extensions.<@) p_scope
       or approved_memory_id = any(v_mem);
  delete from public.rule_candidates where memory_id = any(v_mem);
  delete from public.memory_review_queue
    where memory_a = any(v_mem) or memory_b = any(v_mem);
  delete from public.memory_reinforcement where memory_id = any(v_mem);
  delete from public.memory_entities where memory_id = any(v_mem);
  delete from public.memory_links
    where src = any(v_mem) or dst = any(v_mem);
  -- External successors pointing INTO the deleted set survive, unlinked.
  update public.memories set superseded_by = null
    where superseded_by = any(v_mem)
      and not (scope operator(extensions.<@) p_scope);
  delete from public.edges where scope operator(extensions.<@) p_scope;
  delete from public.entities where scope operator(extensions.<@) p_scope;
  delete from public.memories where scope operator(extensions.<@) p_scope;
  delete from public.project_bindings
    where scope operator(extensions.<@) p_scope;
  delete from public.scope_members where scope operator(extensions.<@) p_scope;
  delete from public.scopes where scope operator(extensions.<@) p_scope;

  return jsonb_build_object('memories_deleted', v_memories);
end;
$$;

comment on function public.delete_scope(extensions.ltree) is
  'Hard-deletes a shared scope subtree: its memories (with every referrer '
  'row), entities, edges, bindings, membership and metadata. External '
  'superseded_by references are nulled. Admin only; irreversible — the '
  'dashboard offers merge_scopes as the loss-free alternative.';

revoke all on function public.delete_scope(extensions.ltree)
  from public, anon;
grant execute on function public.delete_scope(extensions.ltree)
  to authenticated, service_role;

-- 7. hard_delete_user learns the new scopes table ---------------------------

drop function if exists public.hard_delete_user(text);

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

comment on function public.hard_delete_user(text) is
  'Account erasure cascade over the ownership map: deletes everything owned by '
  'the given usr_ id, severs surviving back-references, anonymizes the audit '
  'trail, and removes the profile and auth principal. Idempotent. service_role '
  'only.';

revoke all on function public.hard_delete_user(text) from public;
revoke all on function public.hard_delete_user(text) from anon, authenticated;
grant execute on function public.hard_delete_user(text) to service_role;
