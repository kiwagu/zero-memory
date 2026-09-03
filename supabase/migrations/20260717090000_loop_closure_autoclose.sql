-- Migration: loop-closure auto-close — evidence rollup + re-judge guard
--
-- Purpose:
--   Open loops (kind task / open-question) surface in every briefing until
--   closed, but closing today depends on the finishing agent remembering to
--   call close_loop or declare a supersede. When that diligence step is
--   missed, a completed task keeps nagging every session. The hygiene cycle
--   gains a loop-closure detector: this rollup pairs each live open loop
--   with the newest similar NON-loop memories written after it (the
--   completion evidence), and an LLM judge decides whether the evidence
--   asserts the work is done. High-confidence verdicts close the loop with
--   the same reversible invalidation close_loop uses.
--
-- Affected objects:
--   - function public.find_loop_closure_evidence  (service_role rollup)
--   - table public.loop_closure_checks            (deny-all; re-judge guard)
--
-- Special considerations:
--   - loop_closure_checks prevents re-adjudicating the same (loop, newest
--     evidence) pair every cycle: a judged pair is only re-judged when NEWER
--     evidence appears (lesson from the hygiene scanner, where already-
--     resolved pairs were re-judged nightly until guarded).
--   - The similarity floor is deliberately high (default 0.60 cosine over
--     e5 vectors, tune via detector config): candidates feed a judge whose
--     default is "leave open", so recall matters more than precision here —
--     precision is the judge's job, and the confidence gate is the brake.
--   - Deleting a loop cascades its check row; closing a loop removes it from
--     the rollup by the invalidated_at filter, so the guard table stays tiny.

set search_path = public, extensions;

-- 1. re-judge guard table -------------------------------------------------------

create table public.loop_closure_checks (
  loop_id text primary key references public.memories (id) on delete cascade,
  -- Newest evidence memory considered at the last judgement; a rollup row
  -- with the same newest id has no new information and is skipped.
  last_evidence_id text not null references public.memories (id)
    on delete cascade,
  checked_at timestamptz not null default now()
);

comment on table public.loop_closure_checks is
  'Loop-closure re-judge guard: the newest evidence memory each open loop '
  'was last judged against. Server-only (deny-all RLS); rows disappear with '
  'their loop or evidence memory.';

-- Server-only: the detector reads/writes with the service role; no client
-- path exists (same posture as usage_events / ingest_log).
alter table public.loop_closure_checks enable row level security;
revoke all on public.loop_closure_checks from anon, authenticated;
grant select, insert, update, delete on public.loop_closure_checks
  to service_role;

-- 2. evidence rollup ------------------------------------------------------------

create or replace function public.find_loop_closure_evidence(
  p_owner text default null,
  p_min_similarity double precision default 0.60,
  p_max_evidence integer default 3
)
returns table (
  loop_id text,
  owner_id text,
  evidence_ids text[],
  newest_evidence_id text,
  top_similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with loops as (
    select m.id, m.owner_id, m.embedding, m.created_at
    from public.memories m
    where m.kind in ('task', 'open-question')
      and m.invalidated_at is null
      and m.embedding is not null
      and (p_owner is null or m.owner_id = p_owner)
  ),
  evidence as (
    select
      l.id as loop_id,
      l.owner_id,
      e.id as evidence_id,
      e.created_at,
      1 - (e.embedding operator(extensions.<=>) l.embedding) as similarity
    from loops l
    join public.memories e
      on e.owner_id = l.owner_id
      and e.created_at > l.created_at
      and e.invalidated_at is null
      and e.embedding is not null
      -- A loop never closes a loop: narrowed follow-up tasks stay evidence-
      -- free; only substantive memories (facts, decisions, ...) qualify.
      and e.kind not in ('task', 'open-question')
    where 1 - (e.embedding operator(extensions.<=>) l.embedding)
      >= p_min_similarity
  ),
  ranked as (
    select
      evidence.*,
      row_number() over (
        partition by evidence.loop_id
        order by evidence.similarity desc, evidence.created_at desc
      ) as sim_rank
    from evidence
  )
  select
    r.loop_id,
    r.owner_id,
    -- Judge input: the strongest N matches…
    array_agg(r.evidence_id order by r.similarity desc)
      filter (where r.sim_rank <= greatest(p_max_evidence, 1))
      as evidence_ids,
    -- …but the re-judge guard keys on the newest match overall, so a fresh
    -- weak match still counts as "new information arrived".
    (array_agg(r.evidence_id order by r.created_at desc, r.evidence_id))[1]
      as newest_evidence_id,
    max(r.similarity) as top_similarity
  from ranked r
  group by r.loop_id, r.owner_id;
$$;

comment on function public.find_loop_closure_evidence(
  text, double precision, integer
) is
  'For each live open loop (task/open-question), the top-N newest similar '
  'non-loop memories written after it — completion-evidence candidates for '
  'the loop-closure judge. Granted to service_role only.';

revoke execute on function public.find_loop_closure_evidence(
  text, double precision, integer
) from public, anon, authenticated;
grant execute on function public.find_loop_closure_evidence(
  text, double precision, integer
) to service_role;
