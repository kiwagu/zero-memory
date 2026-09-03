-- Migration: re-examine high-traffic memories when the judge model changes
--
-- Purpose:
--   The pair scan only ever takes RECENT memories as subjects (a lookback
--   window of days), and it skips any pair that already reached the review
--   queue. Both rules are right on their own — they stop the nightly cycle
--   from re-buying the same verdicts and from overturning a decision a person
--   already made — but together they freeze every older memory at the
--   judgement of whatever model was current when it was written. A memory
--   that surfaces in recall every week is exactly the one worth a second
--   opinion once a stronger judge is configured, and today it never gets one.
--
--   This adds the missing axis: a memory is eligible for one re-examination
--   per judge model. The guard table below is the whole mechanism — a run
--   records which model has already looked at a memory, so a stable
--   configuration goes quiet after the first bounded burst and only a model
--   change re-opens the population. Traffic is measured from the recall
--   ledger (how often the memory was actually returned to a client), so the
--   spend lands on knowledge that is genuinely in use rather than on the
--   whole corpus.
--
-- Affected objects:
--   - table public.memory_judge_checks         (new; service-role only)
--   - function public.find_judge_rescan_candidates (new; service-role only)
--   - function public.hard_delete_user         (create or replace: the new
--     table joins the erasure cascade)
--
-- Special considerations:
--   - Traffic comes from `usage_events`, which is deny-all to end users, so
--     the rollup is security INVOKER and granted to service_role only — the
--     same shape the reinforcement rollup uses for the same reason.
--   - The rollup deliberately does NOT filter by age or by whether a pair was
--     ever queued: the caller runs the ordinary single-memory scan, which
--     already applies the queue guard, the cross-project filter and the
--     confidence gates. Duplicating those rules here would be a second place
--     to keep them in step.
--   - Re-examination never mutates anything by itself; it can only reach the
--     same reversible outcomes the scan already produces.

set search_path = public, extensions;

-- 1. guard table -----------------------------------------------------------

create table public.memory_judge_checks (
  memory_id text not null references public.memories (id) on delete cascade
    check (public.is_entity_id_with_prefix(memory_id, 'mem')),
  -- The judge model that examined this memory. Compared by exact string: an
  -- ordering of models would be a guess about which direction is an upgrade,
  -- while "a different model has not spoken yet" is a fact.
  judge_model text not null,
  checked_at timestamptz not null default now(),
  primary key (memory_id, judge_model)
);

comment on table public.memory_judge_checks is
  'Which judge model has already re-examined which memory. Content-free: ids, '
  'a model name and a timestamp. A present row is the reason a run stays '
  'quiet; a newly configured model empties the guard by construction.';

revoke all on public.memory_judge_checks from anon, authenticated;
grant select, insert, update, delete on public.memory_judge_checks
  to service_role;

alter table public.memory_judge_checks enable row level security;

-- 2. candidate rollup ------------------------------------------------------

-- High-traffic live memories the given judge model has not examined yet,
-- most-surfaced first. Traffic = how often recall returned the memory to a
-- client over the window, read from the tool-call ledger.
create or replace function public.find_judge_rescan_candidates(
  p_judge_model text,
  p_window_days integer default 90,
  p_min_surfacings integer default 3,
  p_limit integer default 5,
  p_owner text default null
)
returns table (
  memory_id text,
  owner_id text,
  surfacings integer,
  last_surfaced_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with surfaced as (
    select
      jsonb_array_elements_text(e.metadata -> 'returned_ids') as memory_id,
      e.occurred_at
    from public.usage_events e
    where
      e.event_type = 'mcp_tool_call'
      and jsonb_typeof(e.metadata -> 'returned_ids') = 'array'
      and e.occurred_at
        >= now() - make_interval(days => greatest(p_window_days, 1))
  ),
  traffic as (
    select
      surfaced.memory_id,
      count(*)::integer as surfacings,
      max(surfaced.occurred_at) as last_surfaced_at
    from surfaced
    group by surfaced.memory_id
  )
  select
    m.id as memory_id,
    m.owner_id,
    traffic.surfacings,
    traffic.last_surfaced_at
  from
    traffic
    join public.memories m
      on m.id = traffic.memory_id
      and m.invalidated_at is null
  where
    traffic.surfacings >= greatest(p_min_surfacings, 1)
    and (p_owner is null or m.owner_id = p_owner)
    and not exists (
      select 1
      from public.memory_judge_checks c
      where c.memory_id = m.id and c.judge_model = p_judge_model
    )
  order by traffic.surfacings desc, traffic.last_surfaced_at desc
  limit greatest(p_limit, 1);
$$;

comment on function public.find_judge_rescan_candidates(
  text, integer, integer, integer, text
) is
  'Live memories most often returned by recall over the window that the given '
  'judge model has not examined yet, most-surfaced first; optionally narrowed '
  'to one owner (the interactive scan path). Security invoker; granted to '
  'service_role only (reads deny-all usage_events).';

revoke all on function public.find_judge_rescan_candidates(
  text, integer, integer, integer, text
) from public, anon, authenticated;
grant execute on function public.find_judge_rescan_candidates(
  text, integer, integer, integer, text
) to service_role;

-- 3. erasure covers the new table ------------------------------------------

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

  -- Per-user operational and identity rows.
  delete from public.usage_events where user_id = p_user_id;
  delete from public.usage_daily where user_id = p_user_id;
  delete from public.ingest_log where user_id = p_user_id;
  delete from public.oauth_codes where user_id = p_user_id;
  delete from public.policy_allowances where subject_id = p_user_id;
  delete from public.provider_credentials where subject_id = p_user_id;
  delete from public.project_bindings where created_by = p_user_id;
  delete from public.scope_members where user_id = p_user_id;
  -- Added by the scope-cards epic (20260723120000). Kept explicitly here:
  -- `scopes.created_by` is NO ACTION, so omitting it aborts the profile delete
  -- below — which is exactly how this line was almost lost when this revision
  -- was first drafted from an older one.
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
