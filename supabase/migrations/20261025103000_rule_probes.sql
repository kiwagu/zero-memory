-- Migration: rule-gate probes — the delivery-judge quality measurement
--
-- Purpose:
--   The rule gate decides, per build_context call, how much of each unpinned
--   standing rule a session receives (full text, headline plus condition, or
--   headline). Before its bands are trusted, they are measured against a
--   labelled set: this table stores that set — a task statement an agent
--   actually briefed on, paired with one of the owner's rules and the level
--   the owner says it deserves (expect = 'full': the rule binds the task and
--   must arrive whole; expect = 'headline': it does not bind and must not).
--   The evaluation script (scripts/rule-gate-eval.ts) replays the probes
--   through the judge and through the rankings delivery used before it, and
--   reports hit and false-full rates per ranking.
--
-- Affected objects:
--   - table public.rule_probes (new): the owner's rule-gate probe set.
--
-- Special considerations:
--   - One row is ONE expectation: the topic identifies the replay group,
--     rule_id + expect is the assertion. The script groups rows by topic.
--   - Probe topics are agents' own task statements (copied from build_context
--     calls) and probes name the owner's rules, whose text is their content,
--     so the table is strictly server-only, like brief_probes: privileges
--     revoked from end-user roles, RLS enabled with an explicit deny-all
--     policy, service_role writes. There is no end-user read path; the
--     scripts run service-role.
--   - Probes retire (retired_at), never delete. A probe over a revoked rule
--     is skipped by the script rather than counted.
--   - Both foreign keys cascade. A probe means nothing without its owner or
--     its rule, and every path that removes a rule (account erasure, a rule
--     following its memory, a memory hard-delete) must not be blocked by a
--     measurement row; account erasure therefore needs no statement of its
--     own for this table.

set search_path = public;

-- 1. table --------------------------------------------------------------------

create table public.rule_probes (
  id text primary key default public.entity_id_generate('rpb')
    check (public.is_entity_id_with_prefix(id, 'rpb')),
  owner_id text not null references public.profiles (id) on delete cascade
    check (public.is_entity_id_with_prefix(owner_id, 'usr')),
  -- The task statement replayed through the gate (an agent's build_context topic).
  topic text not null,
  rule_id text not null references public.rule_candidates (id) on delete cascade
    check (public.is_entity_id_with_prefix(rule_id, 'rlc')),
  -- 'full' = the rule binds this task and must be delivered whole;
  -- 'headline' = it does not bind and must not be delivered whole.
  expect text not null check (expect in ('full', 'headline')),
  -- Why, and the rule's type for stratified reporting: 'trigger' or 'trajectory'.
  note text,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

comment on table public.rule_probes is
  'Labelled expectations for the rule gate: a task statement replayed through '
  'the delivery judge, with one of the owner''s rules that must ("full") or must '
  'not ("headline") arrive whole. One row per expectation; the evaluation '
  'script groups by topic. Server-only: topics are agents'' task statements and '
  'rules carry the owner''s content.';

comment on column public.rule_probes.expect is
  '"full" feeds the hit rate (the rule binds the task); "headline" feeds the '
  'false-full rate (the rule does not bind and must not arrive whole).';

comment on column public.rule_probes.note is
  'The rule''s type for stratified reporting ("trigger" or "trajectory"), '
  'optionally followed by why the expectation holds.';

-- 2. indexes ------------------------------------------------------------------

create index rule_probes_owner_active_idx
  on public.rule_probes (owner_id)
  where retired_at is null;

-- The rule foreign key cascades on delete; an index keeps that cascade from
-- scanning the table for every removed rule.
create index rule_probes_rule_id_idx
  on public.rule_probes (rule_id);

-- 3. grants + RLS: server-only --------------------------------------------------

revoke all on public.rule_probes from anon, authenticated;
grant select, insert, update on public.rule_probes to service_role;

alter table public.rule_probes enable row level security;

-- Explicit deny-all (belt-and-suspenders over the revoke, and it keeps the
-- rls_enabled_no_policy advisor clear). service_role bypasses RLS.
create policy "server-only: deny all end-user access"
on public.rule_probes
for all
to anon, authenticated
using (false)
with check (false);
