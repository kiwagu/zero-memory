-- Migration: create memory_review_queue table (memory-hygiene pipeline)
--
-- Purpose:
--   Human-in-the-loop tier of the memory-hygiene pipeline. The server-side
--   hygiene scanner compares active memories against their near neighbours and
--   asks an LLM judge to classify each pair. High-confidence duplicates and
--   supersessions are auto-resolved (Tier-AUTO) through the domain
--   supersede/forget commands, which the audited command bus already records.
--   Everything the judge cannot resolve confidently -- genuine contradictions
--   and low-confidence pairs -- is parked here (Tier-HUMAN) for a person to
--   decide, so hygiene never silently destroys knowledge.
--
-- Affected objects:
--   - table: public.memory_review_queue (RLS enabled, NO policies -> deny-all)
--   - indexes: unique unordered pair, btree (status, created_at), FK covers
--
-- Special considerations:
--   - Deny-all by design: privileges revoked from anon/authenticated, granted
--     only to service_role; RLS enabled with no policy as a second gate. The
--     scanner writes rows and the dashboard reads them, both via the server
--     (service_role) -- these are operational data, not user-owned rows.
--   - entity-id PK with the new `mrq` prefix (application-owned public table).
--   - memory_a / memory_b are the domain `mem_` ids (public.memories). The
--     unordered pair is unique: a given pair is queued at most once regardless
--     of which memory the scan started from.

set search_path = public;

-- 1. table -------------------------------------------------------------------

create table public.memory_review_queue (
  id text primary key default public.entity_id_generate('mrq')
    check (public.is_entity_id_with_prefix(id, 'mrq')),
  -- The candidate pair, stored in canonical order (memory_a < memory_b) so the
  -- unordered pair is unique through a plain constraint and never queued twice,
  -- whichever memory the scan started from.
  memory_a text not null references public.memories (id) on delete cascade
    check (public.is_entity_id_with_prefix(memory_a, 'mem')),
  memory_b text not null references public.memories (id) on delete cascade
    check (public.is_entity_id_with_prefix(memory_b, 'mem')),
  similarity double precision,
  -- The judge's classification of the pair. Direction is carried by `winner`
  -- (the memory that supersedes) rather than the a/b position, so it survives
  -- the canonical reordering above.
  verdict text not null check (
    verdict in ('duplicate', 'supersedes', 'contradiction')
  ),
  -- For verdict = 'supersedes': which memory the judge thinks should win. Null
  -- for duplicate / contradiction (no directional winner proposed).
  winner text references public.memories (id) on delete cascade
    check (winner is null or public.is_entity_id_with_prefix(winner, 'mem')),
  confidence double precision
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  rationale text,
  status text not null default 'pending'
    check (status in ('pending', 'resolved', 'dismissed')),
  -- The action a human chose when resolving (free-form for now: keep_both,
  -- forget_a, forget_b, supersede_a_b, supersede_b_a, merge). Null until acted.
  resolution text,
  resolved_by text references public.profiles (id)
    check (resolved_by is null or public.is_entity_id_with_prefix(resolved_by, 'usr')),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  -- Canonical unordered pair: strict ordering also rules out a self-pair.
  constraint memory_review_queue_pair_order check (memory_a < memory_b),
  -- The proposed winner, when set, must be one of the pair.
  constraint memory_review_queue_winner_in_pair
    check (winner is null or winner in (memory_a, memory_b)),
  unique (memory_a, memory_b)
);

comment on table public.memory_review_queue is
  'Human-review tier of the memory-hygiene pipeline: candidate memory pairs the '
  'LLM judge could not auto-resolve. Deny-all RLS: service_role only.';

-- 2. indexes -----------------------------------------------------------------

-- The unordered-pair uniqueness is enforced by the `unique (memory_a, memory_b)`
-- constraint above (canonical order guarantees one row per pair). Its implicit
-- index also covers the memory_a foreign key.

-- The scanner and dashboard both filter the pending backlog by recency.
create index memory_review_queue_status_created_idx
  on public.memory_review_queue
  using btree (status, created_at);

-- Covering indexes for the remaining foreign keys (advisor lint 0001).
create index memory_review_queue_memory_b_idx
  on public.memory_review_queue
  using btree (memory_b);
create index memory_review_queue_winner_idx
  on public.memory_review_queue
  using btree (winner);
create index memory_review_queue_resolved_by_idx
  on public.memory_review_queue
  using btree (resolved_by);

-- 3. grants: service_role only ----------------------------------------------

-- Deny-all for end users at the privilege layer; the server (service_role)
-- inserts candidates, reads the backlog, and updates rows on resolution.
revoke all on public.memory_review_queue from anon, authenticated;
grant select, insert, update on public.memory_review_queue to service_role;

-- 4. RLS: deny-all -----------------------------------------------------------

-- Belt-and-suspenders on top of the revoke: RLS enabled, no policy, so end
-- users get zero rows even if a grant were ever widened. The service role
-- bypasses RLS and is the only accessor.
alter table public.memory_review_queue enable row level security;
