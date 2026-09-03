-- Migration: brief-holdout probes — the briefing-quality regression metric
--
-- Purpose:
--   The briefing recipe (build_context) is about to be tuned: ranked linked
--   leg, recency section, entity resolution. "Metric before tuning": this
--   table stores the holdout probe set for briefing quality — a topic replayed
--   through build_context, paired with memories that MUST be in the pack
--   (expect = 'present') and memories that must NOT be (expect = 'absent':
--   stale facts, derivable-from-code trivia, other-scope leaks). The eval
--   harness (scripts/search-eval.ts) replays the probes before and after every
--   recipe change and reports pack hit-rate and junk share — the deltas are
--   the regression check.
--
-- Affected objects:
--   - table public.brief_probes (new): the owner's briefing holdout set.
--
-- Special considerations:
--   - One row is ONE expectation: (topic, scopes) identifies the probe group,
--     memory_id + expect is the assertion. The harness groups rows by topic.
--   - Probe topics and notes derive from memory CONTENT, so the table is
--     strictly server-only, like roi_probes: privileges revoked from end-user
--     roles, RLS enabled with an explicit deny-all policy, service_role
--     writes. No end-user read path in v1 (the harness runs service-role).
--   - Probes retire (retired_at), never delete (ADD-only posture). A
--     'present' probe over an invalidated memory cannot be found by design;
--     an 'absent' probe over an invalidated memory is trivially satisfied —
--     both poison the metric and are retired by the harness's live check.
--   - scopes is text[] (cast to ltree[] at call time): it is the scope_filter
--     argument the replay passes to build_context, not a data-model relation.
--     null = unfiltered (the pre-isolation degraded mode).

set search_path = public;

-- 1. table --------------------------------------------------------------------

create table public.brief_probes (
  id text primary key default public.entity_id_generate('bpr')
    check (public.is_entity_id_with_prefix(id, 'bpr')),
  owner_id text not null references public.profiles (id)
    check (public.is_entity_id_with_prefix(owner_id, 'usr')),
  -- The briefing topic replayed through build_context (canonical English,
  -- like stored memory content).
  topic text not null,
  -- scope_filter passed to build_context on replay; null = all visible.
  scopes text[],
  memory_id text not null references public.memories (id)
    check (public.is_entity_id_with_prefix(memory_id, 'mem')),
  -- 'present' = the memory MUST be in the pack (hit-rate numerator);
  -- 'absent'  = the memory must NOT be in the pack (junk-share numerator).
  expect text not null check (expect in ('present', 'absent')),
  -- Why this expectation holds (e.g. "stale: superseded by OAuth decision",
  -- "trivia: derivable from code"). Content-derived, hence server-only.
  note text,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

comment on table public.brief_probes is
  'Holdout expectations for briefing quality: a topic replayed through '
  'build_context, with memories that must ("present") or must not ("absent") '
  'appear in the pack. One row per expectation; the eval harness groups by '
  'topic. Server-only: topics and notes derive from memory content.';

comment on column public.brief_probes.scopes is
  'scope_filter the replay passes to build_context (text paths, cast to '
  'ltree[] at call time); null = all visible scopes.';

comment on column public.brief_probes.expect is
  '"present" feeds the pack hit-rate; "absent" feeds the junk share (stale '
  'facts, derivable-from-code trivia, other-scope leaks).';

-- 2. indexes ------------------------------------------------------------------

create index brief_probes_owner_active_idx
  on public.brief_probes (owner_id)
  where retired_at is null;

-- 3. grants + RLS: server-only --------------------------------------------------

revoke all on public.brief_probes from anon, authenticated;
grant select, insert, update on public.brief_probes to service_role;

alter table public.brief_probes enable row level security;

-- Explicit deny-all (belt-and-suspenders over the revoke, and it keeps the
-- rls_enabled_no_policy advisor clear). service_role bypasses RLS.
create policy "server-only: deny all end-user access"
on public.brief_probes
for all
to anon, authenticated
using (false)
with check (false);

-- 4. harness access ------------------------------------------------------------

-- The eval harness replays probes service-role (so every owner's probes run);
-- build_context's ACL predates that consumer and only carried authenticated.
grant execute on function public.build_context(
  extensions.vector, text, extensions.ltree[], int, int
) to service_role;
