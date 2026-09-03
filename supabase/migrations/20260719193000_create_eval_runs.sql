-- Migration: create public.eval_runs
--
-- Purpose:
--   Keep eval-harness results as DATA rather than as terminal output. The
--   search-quality harness already measures the two things that say whether
--   the engine is getting better or worse — the ROI holdout (hit@K, MRR,
--   reinforced share) and the brief holdout (pack hit-rate, junk share) — but
--   it prints them and forgets them. A number that exists only in a scrollback
--   buffer cannot answer "did the ranking change in June help?", which is the
--   question the whole eval exists to answer.
--
--   Storing runs makes the engine's own quality a time series, on the same
--   footing as the usage metrics rolled up next door.
--
-- Affected objects:
--   - table public.eval_runs (new, deny-all)
--   - index eval_runs_harness_run_at_idx (new)
--
-- Special considerations:
--   - Metrics live in jsonb under STABLE KEYS rather than in columns: each
--     harness reports a different set, and a new measure must not require a
--     migration before it can be recorded. The stability of the keys is what
--     makes the series comparable — renaming one silently breaks history, so
--     keys are treated as a contract by the harness that writes them.
--   - Content-free like every other operational table here: counts and
--     scores, never the probes' text or the memories they matched.
--   - Deny-all: these are operator numbers. The harness runs under the
--     service role; no end user reads this table.

set search_path = public;

create table public.eval_runs (
  id text primary key default public.entity_id_generate('evl')
    check (public.is_entity_id_with_prefix(id, 'evl')),
  run_at timestamptz not null default timezone('utc', now()),
  -- Which holdout produced these numbers. Constrained rather than free text:
  -- a typo here would fork a series in two without anyone noticing.
  harness text not null check (harness in ('roi', 'brief')),
  -- Stable-keyed measures, e.g. {"hit_at_k": 17, "probes": 17, "mrr": 0.961}.
  metrics jsonb not null,
  -- How much material the run had to work with. A hit-rate is not comparable
  -- across corpus sizes, so the size travels with the number that depends on
  -- it rather than being reconstructed from the run date afterwards.
  corpus_size integer not null check (corpus_size >= 0),
  -- What was being measured — a commit sha or release identifier. Nullable on
  -- purpose: a runner that genuinely cannot determine its version records
  -- nothing rather than a plausible-looking guess that would corrupt any
  -- later before/after comparison.
  engine_version text
);

comment on table public.eval_runs is
  'Eval-harness results as data: one row per holdout run. Deny-all RLS, '
  'service_role only. Content-free (counts and scores).';

comment on column public.eval_runs.metrics is
  'Stable-keyed measures for this harness. Keys are a contract: renaming one '
  'silently breaks the comparability of every earlier run.';

-- Reading is always "the recent runs of one harness, newest first".
create index eval_runs_harness_run_at_idx
  on public.eval_runs
  using btree (harness, run_at desc);

revoke all on public.eval_runs from anon, authenticated;
grant select, insert on public.eval_runs to service_role;

alter table public.eval_runs enable row level security;
