-- Migration: reflection candidates — episode-cluster consolidation queue
--
-- Purpose:
--   Reflection: clusters of related episodes (same owner, same scope, shared
--   entities, similar-but-not-duplicate content) should consolidate into ONE
--   living fact instead of paying top-k slots for a story told five times.
--   The server-side detector finds clusters, the LLM distiller drafts the
--   consolidated fact, and the OWNER approves / dismisses / snoozes from the
--   dashboard. Approval writes a NEW memory with derived_from links to every
--   source episode; the sources are NEVER invalidated — ranking-time decay
--   naturally sinks them below the fresh, fuller distillate.
--
-- Affected objects:
--   - table public.reflection_candidates          (queue; owner RLS)
--   - table public.reflection_candidate_members   (cluster membership;
--     unique(memory_id) = one candidacy per episode, ever)
--   - function public.find_reflection_clusters    (service_role rollup)
--
-- Special considerations:
--   - unique (memory_id) on members mirrors rule_candidates' one-candidacy
--     policy: approved/dismissed are terminal for every member; snoozed rows
--     flip back to pending in place (never re-inserted).
--   - The similarity band [min, 0.92) deliberately stops below the write-time
--     same-scope dedup threshold: at/above it a pair is dedup territory
--     (hygiene judge), not consolidation. The floor default matches the
--     hygiene review-candidate floor. An edge additionally requires a shared
--     entity: measured on live data, without it a 0.78 floor glues most of a
--     single-project corpus into one giant component.
--   - The rollup is VOLATILE (uses temp state for label propagation) and
--     service_role-only, like find_rule_candidates.

set search_path = public, extensions;

-- 1. queue table ---------------------------------------------------------------

create table public.reflection_candidates (
  id text primary key default public.entity_id_generate('rfc')
    check (public.is_entity_id_with_prefix(id, 'rfc')),
  -- Cluster owner (all members share it) — denormalized for RLS and queue
  -- filtering; written by the service-role detector only.
  owner_id text not null references public.profiles (id)
    check (public.is_entity_id_with_prefix(owner_id, 'usr')),
  -- Scope the cluster lives in (all members share it); the approved
  -- distillate is written into this scope.
  scope extensions.ltree not null,
  -- Distilled draft (filled by the LLM distiller after insertion; null until
  -- then, so the dashboard queue only lists rows with a draft).
  distilled_content text,
  -- Kind proposed for the consolidated memory, by content.
  distilled_kind text
    check (distilled_kind is null or distilled_kind in ('fact', 'convention')),
  judge_confidence double precision
    check (
      judge_confidence is null
      or (judge_confidence >= 0 and judge_confidence <= 1)
    ),
  judge_rationale text,
  judge_model text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'dismissed', 'snoozed')),
  -- Why the row left pending: approved, dismissed_by_owner, low_confidence
  -- (distiller auto-dismiss). Free-form like memory_review_queue.resolution.
  resolution text,
  resolved_by text references public.profiles (id)
    check (
      resolved_by is null
      or public.is_entity_id_with_prefix(resolved_by, 'usr')
    ),
  resolved_at timestamptz,
  -- Snooze: hidden from the queue until this instant, then the detector flips
  -- the row back to pending.
  snoozed_until timestamptz,
  -- The consolidated memory written on approval (audit trail of the outcome).
  approved_memory_id text references public.memories (id)
    check (
      approved_memory_id is null
      or public.is_entity_id_with_prefix(approved_memory_id, 'mem')
    ),
  created_at timestamptz not null default now()
);

comment on table public.reflection_candidates is
  'Reflection queue: episode clusters proposed for consolidation into one '
  'living fact. Detector inserts (service_role), the distiller drafts, the '
  'owner resolves under their JWT. Approval writes a new memory with '
  'derived_from links; source episodes stay live (decay demotes them).';

-- 2. membership table ----------------------------------------------------------

create table public.reflection_candidate_members (
  candidate_id text not null
    references public.reflection_candidates (id) on delete cascade
    check (public.is_entity_id_with_prefix(candidate_id, 'rfc')),
  memory_id text not null references public.memories (id) on delete cascade
    check (public.is_entity_id_with_prefix(memory_id, 'mem')),
  -- Chronological position within the cluster (0 = oldest surviving member):
  -- the distiller and the card render the story in this order.
  ord integer not null check (ord >= 0),
  primary key (candidate_id, memory_id),
  -- One candidacy per episode, ever: terminal statuses stay terminal and the
  -- detector's insert conflict is the "already claimed" signal.
  unique (memory_id)
);

comment on table public.reflection_candidate_members is
  'Episodes composing one reflection candidate, in chronological order. '
  'unique(memory_id): an episode is proposed for consolidation at most once.';

-- 3. indexes -------------------------------------------------------------------

-- Dashboard backlog: pending rows by recency.
create index reflection_candidates_status_created_idx
  on public.reflection_candidates
  using btree (status, created_at);

-- Detector un-snooze sweep: expired snoozes only.
create index reflection_candidates_snoozed_until_idx
  on public.reflection_candidates
  using btree (snoozed_until)
  where status = 'snoozed';

-- Covering indexes for the foreign keys (advisor lint 0001).
create index reflection_candidates_owner_idx
  on public.reflection_candidates
  using btree (owner_id);

create index reflection_candidates_resolved_by_idx
  on public.reflection_candidates
  using btree (resolved_by);

create index reflection_candidates_approved_memory_idx
  on public.reflection_candidates
  using btree (approved_memory_id);

-- members: pk covers candidate_id, unique covers memory_id.

-- 4. grants --------------------------------------------------------------------

-- The detector (service_role) inserts and updates; the owner reads their
-- queue and resolves rows. Users never insert or delete: rows are the audit
-- trail of candidacy (status flips instead).
revoke all on public.reflection_candidates from anon, authenticated;
grant select, insert, update on public.reflection_candidates to service_role;
grant select, update on public.reflection_candidates to authenticated;

revoke all on public.reflection_candidate_members from anon, authenticated;
grant select, insert on public.reflection_candidate_members to service_role;
grant select on public.reflection_candidate_members to authenticated;

-- 5. RLS -----------------------------------------------------------------------

alter table public.reflection_candidates enable row level security;
alter table public.reflection_candidate_members enable row level security;

-- Owner sees the clusters distilled from their own episodes.
create policy "owners read their reflection candidates"
on public.reflection_candidates
for select
to authenticated
using (owner_id = (select private.current_user_entity_id()));

-- Owner resolves (approve / dismiss / snooze) their own candidates; ownership
-- must still hold after the update.
create policy "owners resolve their reflection candidates"
on public.reflection_candidates
for update
to authenticated
using (owner_id = (select private.current_user_entity_id()))
with check (owner_id = (select private.current_user_entity_id()));

-- Membership rows follow the memory's ownership (mirrors rule_candidates).
create policy "owners read their reflection members"
on public.reflection_candidate_members
for select
to authenticated
using (private.owns_memory(memory_id));

-- 6. cluster rollup -------------------------------------------------------------

-- Connected components over "related episodes": same owner + same scope,
-- cosine similarity inside [p_min_similarity, p_max_similarity), and at least
-- one shared entity. Label propagation instead of a recursive CTE: no cycle
-- risk, and the eligible set is small (episodes not yet claimed by any
-- candidacy). VOLATILE because it uses temp state; service_role only.
create or replace function public.find_reflection_clusters(
  p_owner text default null,
  p_min_similarity double precision default 0.78,
  p_max_similarity double precision default 0.92,
  p_min_size integer default 3,
  p_max_members integer default 10
)
returns table (
  cluster_key text,
  owner_id text,
  scope text,
  memory_ids text[]
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_changed integer;
begin
  create temp table if not exists reflection_lbl (
    id text primary key,
    lbl text not null
  ) on commit drop;
  -- truncate, not DELETE: PostgREST sessions load safeupdate, which rejects
  -- an unqualified DELETE even inside a function.
  truncate reflection_lbl;

  -- Eligible episodes: live, embedded, never part of any candidacy.
  insert into reflection_lbl (id, lbl)
  select m.id, m.id
  from public.memories m
  where
    m.kind = 'episode'
    and m.invalidated_at is null
    and m.embedding is not null
    and (p_owner is null or m.owner_id = p_owner)
    and not exists (
      select 1 from public.reflection_candidate_members mem
      where mem.memory_id = m.id
    );

  create temp table if not exists reflection_edge (
    a text not null,
    b text not null
  ) on commit drop;
  truncate reflection_edge;

  insert into reflection_edge (a, b)
  select x.id, y.id
  from
    public.memories x
    join reflection_lbl lx on lx.id = x.id
    -- ltree equality must be schema-qualified under the pinned empty
    -- search_path (same rationale as search_memories' array_position).
    join public.memories y
      on y.owner_id = x.owner_id
      and y.scope operator(extensions.=) x.scope
    join reflection_lbl ly on ly.id = y.id
  where
    x.id < y.id
    and 1 - (x.embedding operator(extensions.<=>) y.embedding)
      >= p_min_similarity
    and 1 - (x.embedding operator(extensions.<=>) y.embedding)
      < p_max_similarity
    and exists (
      select 1
      from
        public.memory_entities ea
        join public.memory_entities eb on eb.entity_id = ea.entity_id
      where ea.memory_id = x.id and eb.memory_id = y.id
    );

  -- Propagate the smallest label across edges until stable.
  loop
    update reflection_lbl
    set lbl = least(reflection_lbl.lbl, next_lbl.min_lbl)
    from (
      select e.a as id, min(lb.lbl) as min_lbl
      from reflection_edge e
      join reflection_lbl lb on lb.id = e.b
      group by e.a
      union all
      select e.b as id, min(la.lbl) as min_lbl
      from reflection_edge e
      join reflection_lbl la on la.id = e.a
      group by e.b
    ) as next_lbl
    where next_lbl.id = reflection_lbl.id
      and next_lbl.min_lbl < reflection_lbl.lbl;
    get diagnostics v_changed = row_count;
    exit when v_changed = 0;
  end loop;

  -- Clusters of the required size; members chronological, capped to the
  -- NEWEST p_max_members (the distillate must reflect the latest state).
  return query
  select
    md5(string_agg(ranked.id, ',' order by ranked.id)) as cluster_key,
    min(ranked.owner_id) as owner_id,
    min(ranked.scope_text) as scope,
    (array_agg(ranked.id order by ranked.created_at asc)) as memory_ids
  from (
    select
      lb.lbl,
      m.id,
      m.owner_id,
      m.scope::text as scope_text,
      m.created_at,
      row_number() over (
        partition by lb.lbl order by m.created_at desc
      ) as recency_rank
    from reflection_lbl lb
    join public.memories m on m.id = lb.id
  ) as ranked
  where ranked.recency_rank <= greatest(p_max_members, 2)
  group by ranked.lbl
  having count(*) >= greatest(p_min_size, 2);
end;
$$;

comment on function public.find_reflection_clusters(
  text, double precision, double precision, integer, integer
) is
  'Connected components of related live episodes (same owner+scope, cosine '
  'in [min,max), shared entity) not yet claimed by a reflection candidacy — '
  'the reflection detector''s cluster source. Members chronological, capped '
  'to the newest p_max_members. Volatile (temp-table label propagation); '
  'granted to service_role only.';

revoke all on function public.find_reflection_clusters(
  text, double precision, double precision, integer, integer
) from public, anon, authenticated;
grant execute on function public.find_reflection_clusters(
  text, double precision, double precision, integer, integer
) to service_role;
