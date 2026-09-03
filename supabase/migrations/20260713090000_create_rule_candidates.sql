-- Migration: create rule_candidates table + detection rollup (rules incubator)
--
-- Purpose:
--   Solo rules incubator: memories that empirically earned a place in an
--   always-on rules layer (re-asked with a useful verdict in enough distinct
--   sessions) become review candidates. The server-side detector inserts one
--   row per qualifying memory, an LLM distiller fills the imperative rule
--   draft, and the OWNER approves / dismisses / snoozes from the dashboard.
--   Approval never writes user files: the dashboard renders a copy/download
--   block and marks the row promoted, which permanently retires the memory
--   from candidacy (a promoted fact is delivered by the rules layer, so
--   proposing it again would pay twice).
--
-- Affected objects:
--   - table:    public.rule_candidates (owner RLS: select/update; inserts are
--               service_role only)
--   - function: public.find_rule_candidates (security invoker, service_role
--               only) — usage_events rollup that yields qualifying memories
--
-- Special considerations:
--   - unique (memory_id): one candidacy per memory, ever. promoted / dismissed
--     are terminal (the rollup excludes any memory with an existing row);
--     snoozed rows are flipped back to pending by the detector once
--     snoozed_until passes — never re-inserted.
--   - "Unique sessions" counts distinct conversation ids from recall_used
--     metadata; events without one (in-band remembers) fall back to a per-day
--     bucket, so the count can only undercount — conservative by design.
--   - Rows reference memories (owner comes from the join); RLS reuses
--     private.owns_memory, mirroring memory_review_queue.

set search_path = public;

-- 1. table -------------------------------------------------------------------

create table public.rule_candidates (
  id text primary key default public.entity_id_generate('rlc')
    check (public.is_entity_id_with_prefix(id, 'rlc')),
  -- The memory that earned candidacy. One candidacy per memory, ever: the
  -- unique constraint (not status) is what makes promoted/dismissed terminal.
  memory_id text not null references public.memories (id) on delete cascade
    check (public.is_entity_id_with_prefix(memory_id, 'mem')),
  -- Detection evidence (content-free: counts, timestamps, session keys).
  useful_sessions integer not null,
  window_days integer not null,
  first_used_at timestamptz,
  last_used_at timestamptz,
  -- Distinct session keys behind useful_sessions (conversation ids or day
  -- buckets) — the dashboard shows them as "when this fact fired".
  session_keys jsonb,
  -- Distilled draft (filled by the LLM distiller after insertion; null until
  -- then, so the dashboard queue only lists rows with a draft).
  rule_text text,
  -- Proposed always-on layer, derived from the memory scope: user.* scopes →
  -- the personal rules file, everything else → the project rules layer.
  target_layer text
    check (target_layer is null or target_layer in ('user', 'project')),
  judge_confidence double precision
    check (
      judge_confidence is null
      or (judge_confidence >= 0 and judge_confidence <= 1)
    ),
  judge_rationale text,
  judge_model text,
  status text not null default 'pending'
    check (status in ('pending', 'promoted', 'dismissed', 'snoozed')),
  -- Why the row left pending: promoted, dismissed_by_owner, low_confidence
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
  promoted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (memory_id)
);

comment on table public.rule_candidates is
  'Rules-incubator queue: memories that earned promotion into an always-on '
  'rules file, with usage evidence and the distilled draft. Scanner inserts '
  '(service_role); the owner reviews and resolves under their JWT.';

-- 2. indexes -----------------------------------------------------------------

-- unique (memory_id) above also covers the memory_id foreign key.

-- Dashboard backlog: pending rows by recency.
create index rule_candidates_status_created_idx
  on public.rule_candidates
  using btree (status, created_at);

-- Detector un-snooze sweep: expired snoozes only.
create index rule_candidates_snoozed_until_idx
  on public.rule_candidates
  using btree (snoozed_until)
  where status = 'snoozed';

-- Covering index for the resolved_by foreign key (advisor lint 0001).
create index rule_candidates_resolved_by_idx
  on public.rule_candidates
  using btree (resolved_by);

-- 3. grants ------------------------------------------------------------------

-- The detector (service_role) inserts and updates; the owner reads their
-- queue and resolves rows. Users never insert or delete: rows are the audit
-- trail of candidacy (status flips instead).
revoke all on public.rule_candidates from anon, authenticated;
grant select, insert, update on public.rule_candidates to service_role;
grant select, update on public.rule_candidates to authenticated;

-- 4. RLS ---------------------------------------------------------------------

alter table public.rule_candidates enable row level security;

-- Owner sees the candidates distilled from their own memories.
create policy "owners read their rule candidates"
on public.rule_candidates
for select
to authenticated
using (private.owns_memory(memory_id));

-- Owner resolves (approve / dismiss / snooze) their own candidates; ownership
-- must still hold after the update.
create policy "owners resolve their rule candidates"
on public.rule_candidates
for update
to authenticated
using (private.owns_memory(memory_id))
with check (private.owns_memory(memory_id));

-- 5. detection rollup --------------------------------------------------------

-- Qualifying memories for rule candidacy: active durable-kind memories whose
-- recall_used(useful=true) events span at least p_min_sessions distinct
-- sessions inside the window, that are stable (did not supersede anything in
-- the last p_stability_days — a freshly corrected fact is still churning),
-- and that have never been a candidate before.
create or replace function public.find_rule_candidates(
  p_owner text default null,
  p_window_days int default 30,
  p_min_sessions int default 3,
  p_stability_days int default 7
)
returns table (
  memory_id text,
  owner_id text,
  kind text,
  scope text,
  content text,
  useful_sessions int,
  first_used_at timestamptz,
  last_used_at timestamptz,
  session_keys jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with useful as (
    select
      e.metadata->>'mem_id' as memory_id,
      -- Session key: the transcript conversation id when the emit carried
      -- one, else a per-day bucket — distinct-count can only undercount.
      coalesce(
        e.metadata->>'conversation_id',
        to_char(e.occurred_at, 'YYYY-MM-DD')
      ) as session_key,
      e.occurred_at
    from public.usage_events e
    where
      e.event_type = 'recall_used'
      and (e.metadata->>'useful')::boolean is true
      and e.metadata->>'mem_id' is not null
      and e.occurred_at >= now() - make_interval(days => p_window_days)
  )
  select
    m.id as memory_id,
    m.owner_id,
    m.kind,
    m.scope::text as scope,
    m.content,
    count(distinct u.session_key)::int as useful_sessions,
    min(u.occurred_at) as first_used_at,
    max(u.occurred_at) as last_used_at,
    jsonb_agg(distinct u.session_key) as session_keys
  from useful u
  join public.memories m on m.id = u.memory_id
  where
    m.invalidated_at is null
    and m.superseded_by is null
    and m.kind in ('convention', 'preference', 'gotcha')
    and (p_owner is null or m.owner_id = p_owner)
    -- Stability: a memory that just replaced another is still churning; let
    -- it settle before proposing it as an always-on rule.
    and not exists (
      select 1
      from public.memory_links l
      where
        l.src = m.id
        and l.type = 'supersedes'
        and l.created_at >= now() - make_interval(days => p_stability_days)
    )
    -- One candidacy per memory, ever: promoted/dismissed are terminal and
    -- snoozed rows are re-pended in place, never re-inserted.
    and not exists (
      select 1
      from public.rule_candidates rc
      where rc.memory_id = m.id
    )
  group by m.id, m.owner_id, m.kind, m.scope
  having count(distinct u.session_key) >= p_min_sessions
$$;

comment on function public.find_rule_candidates(text, int, int, int) is
  'Rules-incubator detection rollup: active convention/preference/gotcha '
  'memories with useful recall_used events in >= p_min_sessions distinct '
  'sessions within the window, stable and never a candidate before. Security '
  'invoker; granted to service_role only.';

revoke all on function public.find_rule_candidates(text, int, int, int)
  from public, anon, authenticated;
grant execute on function public.find_rule_candidates(text, int, int, int)
  to service_role;
