-- Migration: epistemic re-verification — freshness ledger + candidate rollup
--
-- Purpose:
--   The corpus can only outgrow itself by taking in information from OUTSIDE
--   it. This migration lays the shared substrate for that intake: a
--   content-free record of when each memory was last checked against its
--   oracle, plus the rollup that picks which world-facts are due for a check.
--
--   Authority of a record = the freshness of its last reality-check, not the
--   fact that it exists. Nothing here expires or retires anything: the ledger
--   only records WHEN a check happened, and a check that finds a record
--   outdated raises a review-queue dispute (the same single-subject class the
--   challenge/stale-suspect machinery already resolves) rather than mutating
--   the record.
--
-- Affected objects:
--   - table    public.memory_verification        (new; owner-readable)
--   - function public.find_reverify_candidates   (new; service_role rollup)
--
-- Special considerations:
--   - STRATIFICATION: only the FAST layer is re-verified — memories whose
--     truth comes from the outside world. That layer is identified
--     deterministically by scope + kind (core scope ∧ fact/reference), never
--     by a prompt-assigned label and never by a second metadata axis: the
--     scope IS the materialized write-time portability classifier, so a
--     second axis would be a competing source of truth. Conventions and
--     preferences (the slow layer) are out of reach here by construction —
--     their oracle is the owner, not a document.
--   - The candidate set is bounded at the SQL level (per-kind TTL, no open
--     dispute, hard cap, most-used first) so the cost of a run is a property
--     of the query, not of the caller's diligence.

set search_path = public, extensions;

-- 1. freshness ledger ----------------------------------------------------------

create table public.memory_verification (
  memory_id text primary key references public.memories (id) on delete cascade
    check (public.is_entity_id_with_prefix(memory_id, 'mem')),
  -- When this memory was last checked against an external oracle.
  last_verified_at timestamptz not null default now(),
  -- Outcome of that check. 'outdated' is deliberately NOT a value here: an
  -- outdated record becomes a review-queue dispute, and its row stays at the
  -- previous verdict until a human or agent resolves it.
  verdict text not null check (verdict in ('current', 'unverifiable')),
  -- Which judge generation produced it (mirrors invalidated_by_model), so a
  -- model upgrade can re-adjudicate later without guessing.
  verified_by_model text,
  -- How many times this memory has been checked (observability only).
  checks integer not null default 1 check (checks >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.memory_verification is
  'Content-free freshness ledger: when each memory was last checked against '
  'an external oracle and how that check ended. Ids, timestamps and counters '
  'only. An absent row means never checked — the age of the memory itself is '
  'then the staleness signal.';

-- 2. grants + RLS ---------------------------------------------------------------

revoke all on public.memory_verification from anon, authenticated;
grant select, insert, update, delete
  on public.memory_verification to service_role;
grant select on public.memory_verification to authenticated;

alter table public.memory_verification enable row level security;

-- The owner may see the freshness of their own memories (recall annotates
-- stale hits from it); only the service-role hygiene cycle writes.
create policy "owners read their verification records"
on public.memory_verification
for select
to authenticated
using (private.owns_memory(memory_id));

-- 3. candidate rollup -----------------------------------------------------------

-- Live FAST-LAYER memories due for an external re-check, most-used first.
--
-- Fast layer = core scope (portable, world-facing knowledge by construction)
-- AND kind in (fact, reference). Project scopes are never audited here: their
-- oracle is the project's own reality, and their content would carry project
-- context into an external lookup.
--
-- Due = no verification row (never checked, so the memory's own age counts)
-- or the last check is older than the per-kind TTL. Memories already sitting
-- in an open single-subject dispute are skipped — the question is already
-- being asked. Ordering by the reinforcement multiplier spends the run's cap
-- on the records that actually surface in recall.
create or replace function public.find_reverify_candidates(
  p_ttl_fact_days integer default 180,
  p_ttl_reference_days integer default 90,
  p_limit integer default 10
)
returns table (
  memory_id text,
  owner_id text,
  kind text,
  content text,
  last_verified_at timestamptz,
  age_days integer,
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
    v.last_verified_at,
    extract(
      day from now() - coalesce(v.last_verified_at, m.created_at)
    )::integer as age_days,
    coalesce(r.multiplier, 1.0)::double precision as multiplier
  from
    public.memories m
    left join public.memory_verification v on v.memory_id = m.id
    left join public.memory_reinforcement r on r.memory_id = m.id
  where
    m.invalidated_at is null
    and m.scope operator(extensions.~) '*.core'::extensions.lquery
    and m.kind in ('fact', 'reference')
    and coalesce(v.last_verified_at, m.created_at)
      < now() - make_interval(
        days => case m.kind
          when 'reference' then greatest(p_ttl_reference_days, 1)
          else greatest(p_ttl_fact_days, 1)
        end
      )
    and not exists (
      select 1
      from public.memory_review_queue q
      where
        q.memory_a = m.id
        and q.memory_b is null
        and q.status = 'pending'
    )
  order by coalesce(r.multiplier, 1.0) desc, m.created_at asc
  limit greatest(p_limit, 1);
$$;

comment on function public.find_reverify_candidates(integer, integer, integer) is
  'Live core-scope fact/reference memories whose last external check is older '
  'than the per-kind TTL (or that were never checked), excluding those with an '
  'open single-subject dispute, most-reinforced first, hard-capped. The '
  'fast-layer selection is deterministic (scope + kind), never a prompt label. '
  'Security invoker; granted to service_role only.';

revoke all on function public.find_reverify_candidates(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.find_reverify_candidates(integer, integer, integer)
  to service_role;
