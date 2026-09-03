-- Migration: portability audit — reviewable project→core re-scope proposals
--
-- Purpose:
--   World facts stranded in project scopes are invisible to the core-scope
--   external re-verification pass and get rediscovered project by project.
--   This migration adds the review queue for the portability audit: the
--   hygiene detector proposes moving a portable project-scope fact/reference
--   into the owner's personal core scope, and the OWNER approves or dismisses
--   from the dashboard. Nothing is ever re-scoped automatically.
--
-- Affected objects:
--   - table    public.portability_candidates          (queue; owner RLS)
--   - function public.find_portability_candidates     (service_role rollup)
--   - function public.resolve_portability_candidate   (security definer,
--     authenticated: approve applies the re-scope; both outcomes audited)
--
-- Special considerations:
--   - EVERY step leaves an audit_log row (proposal and auto-dismissal by the
--     detector, approve/dismiss through the resolve RPC): the proposal, its
--     resolution, and the memory's from→to scopes are the dataset a later
--     pass joins against usage evidence to score whether promoting a memory
--     into core helps or hurts its usefulness.
--   - unique (memory_id) is the one-candidacy policy AND the re-judge guard:
--     a dismissed proposal is terminal, so the judge is never re-asked about
--     the same memory.
--   - The re-scope is reversible by construction: from_scope stays on the
--     row and in the audit payload; restoring is one scope update back.
--   - Only PRIVATE memories are candidates: a shared row moved into the
--     personal core scope would silently vanish for everyone it was shared
--     with.

set search_path = public, extensions;

-- 1. queue table ---------------------------------------------------------------

create table public.portability_candidates (
  id text primary key default public.entity_id_generate('ptc')
    check (public.is_entity_id_with_prefix(id, 'ptc')),
  -- Memory owner — denormalized for RLS and queue filtering; written by the
  -- service-role detector only.
  owner_id text not null references public.profiles (id)
    check (public.is_entity_id_with_prefix(owner_id, 'usr')),
  -- One candidacy per memory, ever: approved/dismissed are terminal, and the
  -- detector's insert conflict is the "already judged" signal.
  memory_id text not null unique references public.memories (id)
    on delete cascade
    check (public.is_entity_id_with_prefix(memory_id, 'mem')),
  -- Scope the memory lived in when proposed (the reversal target).
  from_scope extensions.ltree not null,
  -- The owner's personal core scope the approval moves the memory into.
  to_scope extensions.ltree not null,
  judge_confidence double precision
    check (
      judge_confidence is null
      or (judge_confidence >= 0 and judge_confidence <= 1)
    ),
  judge_rationale text,
  judge_model text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'dismissed')),
  -- Why the row left pending: approved, dismissed_by_owner, low_confidence
  -- (judge auto-dismiss). Free-form like memory_review_queue.resolution.
  resolution text,
  resolved_by text references public.profiles (id)
    check (
      resolved_by is null
      or public.is_entity_id_with_prefix(resolved_by, 'usr')
    ),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.portability_candidates is
  'Portability audit queue: project-scope memories the judge deems portable, '
  'proposed for a re-scope into the owner''s personal core scope. Detector '
  'inserts (service_role); the owner resolves through the resolve RPC — the '
  'system never re-scopes on its own. unique(memory_id): one candidacy per '
  'memory, ever.';

-- 2. indexes -------------------------------------------------------------------

-- Dashboard backlog: pending rows by recency.
create index portability_candidates_status_created_idx
  on public.portability_candidates
  using btree (status, created_at);

-- Covering indexes for the foreign keys (advisor lint 0001); memory_id is
-- covered by its unique constraint.
create index portability_candidates_owner_idx
  on public.portability_candidates
  using btree (owner_id);

create index portability_candidates_resolved_by_idx
  on public.portability_candidates
  using btree (resolved_by);

-- 3. grants --------------------------------------------------------------------

-- The detector (service_role) inserts, updates, and releases failed claims
-- (delete). Owners READ their queue; resolution goes exclusively through the
-- security-definer RPC so the status flip, the re-scope, and the audit row
-- stay one atomic step — no direct update grant.
revoke all on public.portability_candidates from anon, authenticated;
grant select, insert, update, delete
  on public.portability_candidates to service_role;
grant select on public.portability_candidates to authenticated;

-- 4. RLS -----------------------------------------------------------------------

alter table public.portability_candidates enable row level security;

create policy "owners read their portability candidates"
on public.portability_candidates
for select
to authenticated
using (owner_id = (select private.current_user_entity_id()));

-- 5. candidate rollup ------------------------------------------------------------

-- Live PRIVATE project-scope memories of a world-facing kind with no
-- candidacy yet and no open review-queue row, most-reinforced first. This is
-- the deterministic prefilter of the audit: it only decides which memories
-- are worth a judge call — the judge confirms portability, the owner decides.
--
-- The kinds are fact, reference and gotcha: knowledge whose truth lives in
-- the outside world. A gotcha about a public tool is the class that gets
-- rediscovered project after project, which is what this audit exists to
-- stop; it is included even though the core-scope re-verification pass will
-- not pick it up (that one reads fact/reference), because the value of the
-- promotion is cross-project visibility. Conventions and preferences are
-- excluded on purpose: their oracle is the owner, not a public source.
create or replace function public.find_portability_candidates(
  p_owner text default null,
  p_limit integer default 10
)
returns table (
  memory_id text,
  owner_id text,
  kind text,
  content text,
  scope text,
  multiplier double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    m.id as memory_id,
    m.owner_id,
    m.kind,
    m.content,
    m.scope::text as scope,
    coalesce(r.multiplier, 1.0)::double precision as multiplier
  from
    public.memories m
    left join public.memory_reinforcement r on r.memory_id = m.id
  where
    m.invalidated_at is null
    and m.scope operator(extensions.<@) 'proj'::extensions.ltree
    and m.kind in ('fact', 'reference', 'gotcha')
    -- A shared memory re-scoped into the personal core scope would vanish
    -- for everyone it is shared with; only private rows are portable.
    and m.visibility = 'private'
    and (p_owner is null or m.owner_id = p_owner)
    and not exists (
      select 1
      from public.portability_candidates pc
      where pc.memory_id = m.id
    )
    -- A memory already under review (pair conflict or single-subject
    -- dispute) has an open question about its content; settle that first.
    and not exists (
      select 1
      from public.memory_review_queue q
      where
        (q.memory_a = m.id or q.memory_b = m.id)
        and q.status = 'pending'
    )
  order by coalesce(r.multiplier, 1.0) desc, m.created_at asc
  limit greatest(p_limit, 1);
$$;

comment on function public.find_portability_candidates(text, integer) is
  'Live private project-scope memories of a world-facing kind (fact, '
  'reference, gotcha) with no portability candidacy (any status — '
  'dismissals are terminal) and no pending review row, most-reinforced '
  'first, hard-capped. The deterministic prefilter of the portability '
  'audit. Security invoker; granted to service_role only.';

revoke all on function public.find_portability_candidates(text, integer)
  from public, anon, authenticated;
grant execute on function public.find_portability_candidates(text, integer)
  to service_role;

-- 6. resolve RPC -----------------------------------------------------------------

-- Owner decision on one pending proposal. Approval applies the re-scope
-- (project → core) on the still-live memory; dismissal only closes the row.
-- Both outcomes write the audit_log entry inside the same transaction — the
-- deny-all audit table is reachable here only because the function runs as
-- its definer. The audit payload carries the from→to scopes and the judge
-- confidence so resolutions can later be joined against usage evidence.
create or replace function public.resolve_portability_candidate(
  p_candidate_id text,
  p_approve boolean
)
returns table (
  candidate_id text,
  memory_id text,
  status text,
  from_scope text,
  to_scope text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller text := (select private.current_user_entity_id());
  v_row public.portability_candidates%rowtype;
  v_now timestamptz := now();
begin
  if v_caller is null then
    raise exception 'not authenticated'
      using errcode = '28000';
  end if;

  -- Ownership + pending state in one guarded read (definer bypasses RLS, so
  -- the owner filter is explicit). Locked so a double-click cannot resolve
  -- the same proposal twice.
  select pc.* into v_row
    from public.portability_candidates pc
    where
      pc.id = p_candidate_id
      and pc.owner_id = v_caller
      and pc.status = 'pending'
    for update;
  if not found then
    raise exception
      'portability candidate not found, not owned by you, or already resolved'
      using errcode = 'P0002';
  end if;

  if p_approve then
    -- The re-scope applies only to the memory the proposal was made about:
    -- still live and still in the proposed from_scope. A memory that moved
    -- or was retired since makes the proposal moot — refuse rather than
    -- guess, the owner can dismiss it.
    update public.memories m
      set scope = v_row.to_scope
      where
        m.id = v_row.memory_id
        and m.owner_id = v_caller
        and m.invalidated_at is null
        and m.scope operator(extensions.=) v_row.from_scope;
    if not found then
      raise exception
        'memory is no longer live in the proposed scope; dismiss the proposal'
        using errcode = 'P0001';
    end if;

    update public.portability_candidates pc
      set
        status = 'approved',
        resolution = 'approved',
        resolved_by = v_caller,
        resolved_at = v_now
      where pc.id = p_candidate_id;
  else
    update public.portability_candidates pc
      set
        status = 'dismissed',
        resolution = 'dismissed_by_owner',
        resolved_by = v_caller,
        resolved_at = v_now
      where pc.id = p_candidate_id;
  end if;

  insert into public.audit_log
    (actor_id, author_kind, command, payload, outcome)
  values (
    v_caller,
    'human',
    case when p_approve then 'portability.approve'
         else 'portability.dismiss' end,
    jsonb_build_object(
      'candidate', v_row.id,
      'memory_id', v_row.memory_id,
      'from_scope', v_row.from_scope::text,
      'to_scope', v_row.to_scope::text,
      'confidence', v_row.judge_confidence
    ),
    'ok'
  );

  return query
    select
      pc.id,
      pc.memory_id,
      pc.status,
      pc.from_scope::text,
      pc.to_scope::text
    from public.portability_candidates pc
    where pc.id = p_candidate_id;
end;
$$;

comment on function public.resolve_portability_candidate(text, boolean) is
  'Owner decision on one pending portability proposal: approve re-scopes the '
  'still-live memory from its project scope into the owner''s core scope '
  '(reversible — from_scope stays recorded); dismiss closes the row. Both '
  'outcomes write an audit_log entry in the same transaction. Security '
  'definer, ownership-gated; granted to authenticated.';

revoke all on function public.resolve_portability_candidate(text, boolean)
  from public, anon;
grant execute on function public.resolve_portability_candidate(text, boolean)
  to authenticated;
