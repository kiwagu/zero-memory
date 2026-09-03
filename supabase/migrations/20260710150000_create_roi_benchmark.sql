-- Migration: ROI benchmark — holdout probes, run results, dashboard_roi RPC
--
-- Purpose:
--   The counterfactual "with memory vs without" benchmark: holdout questions
--   (probes) are derived from the owner's own memories (each probe's source
--   memory is its ground truth), a run recalls each question and judges two
--   arms — did the surfaced facts answer it (WITH), and could a competent
--   agent have answered without project memory (WITHOUT). The headline is the
--   exclusive rate: questions only memory could answer.
--
-- Affected objects:
--   - table public.roi_probes (new): the owner's holdout question set.
--   - table public.roi_results (new): one judged row per probe per run.
--   - function public.dashboard_roi() -> jsonb: per-run aggregates for the
--     dashboard tile (last 12 runs, caller-scoped).
--
-- Special considerations:
--   - Probe questions derive from memory CONTENT, so both tables are strictly
--     server-only: privileges revoked from end-user roles, RLS enabled with an
--     explicit deny-all policy (legibility), service_role writes, and the only
--     end-user read path is the security-definer dashboard_roi hard-filtered
--     to the caller.
--   - Probes retire (retired_at) when their source memory is invalidated —
--     history is kept, never deleted (ADD-only posture).

set search_path = public;

-- 1. tables -------------------------------------------------------------------

create table public.roi_probes (
  id text primary key default public.entity_id_generate('prb')
    check (public.is_entity_id_with_prefix(id, 'prb')),
  owner_id text not null references public.profiles (id)
    check (public.is_entity_id_with_prefix(owner_id, 'usr')),
  question text not null,
  source_memory_id text not null references public.memories (id)
    check (public.is_entity_id_with_prefix(source_memory_id, 'mem')),
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

comment on table public.roi_probes is
  'Holdout questions for the counterfactual ROI benchmark, derived from the '
  'owner''s own memories (the source memory is the ground truth). Server-only: '
  'question text derives from memory content.';

create table public.roi_results (
  id text primary key default public.entity_id_generate('rrs')
    check (public.is_entity_id_with_prefix(id, 'rrs')),
  run_id text not null
    check (public.is_entity_id_with_prefix(run_id, 'rrn')),
  probe_id text not null references public.roi_probes (id),
  owner_id text not null references public.profiles (id)
    check (public.is_entity_id_with_prefix(owner_id, 'usr')),
  run_at timestamptz not null default now(),
  with_memory boolean not null,
  without_memory boolean not null,
  confidence numeric not null default 0
    check (confidence >= 0 and confidence <= 1),
  model text
);

comment on table public.roi_results is
  'One judged benchmark row per probe per run: with_memory = the surfaced '
  'facts answered the question; without_memory = a competent agent could have '
  'answered without project memory. Append-only, server-only.';

-- 2. indexes ------------------------------------------------------------------

create index roi_probes_owner_active_idx
  on public.roi_probes (owner_id)
  where retired_at is null;

create index roi_results_owner_run_idx
  on public.roi_results (owner_id, run_at desc);

-- 3. grants + RLS: server-only ------------------------------------------------

revoke all on public.roi_probes from anon, authenticated;
revoke all on public.roi_results from anon, authenticated;
grant select, insert, update on public.roi_probes to service_role;
grant select, insert on public.roi_results to service_role;

alter table public.roi_probes enable row level security;
alter table public.roi_results enable row level security;

-- Explicit deny-all (belt-and-suspenders over the revoke, and it keeps the
-- rls_enabled_no_policy advisor clear). service_role bypasses RLS.
create policy "server-only: deny all end-user access"
on public.roi_probes
for all
to anon, authenticated
using (false)
with check (false);

create policy "server-only: deny all end-user access"
on public.roi_results
for all
to anon, authenticated
using (false)
with check (false);

-- 4. dashboard RPC ------------------------------------------------------------

create or replace function public.dashboard_roi()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_usr text := private.current_user_entity_id();
  v_runs jsonb := '[]'::jsonb;
begin
  if v_usr is null then
    return jsonb_build_object('runs', '[]'::jsonb);
  end if;

  -- Last 12 runs, oldest first (chart-ready). exclusive = answered WITH
  -- memory and NOT answerable without — the headline counterfactual.
  select coalesce(jsonb_agg(r order by r.run_at), '[]'::jsonb)
  into v_runs
  from (
    select
      x.run_id,
      max(x.run_at) as run_at,
      count(*)::int as probes,
      count(*) filter (where x.with_memory)::int as with_num,
      count(*) filter (where x.without_memory)::int as without_num,
      count(*) filter (
        where x.with_memory and not x.without_memory
      )::int as exclusive_num
    from public.roi_results x
    where x.owner_id = v_usr
    group by x.run_id
    order by max(x.run_at) desc
    limit 12
  ) r;

  return jsonb_build_object('runs', v_runs);
end;
$$;

comment on function public.dashboard_roi() is
  'Per-run aggregates of the counterfactual ROI benchmark for the caller '
  '(last 12 runs): probes, with/without counts and the exclusive count '
  '(answerable only with memory). Security definer over server-only tables; '
  'hard-filtered to the calling user.';

-- REST-callable by signed-in users only; the function self-scopes to the JWT.
revoke all on function public.dashboard_roi()
  from public, anon;
grant execute on function public.dashboard_roi()
  to authenticated;
