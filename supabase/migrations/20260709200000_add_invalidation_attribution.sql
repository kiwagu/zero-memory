-- Migration: attribute automatic invalidations (agent + model)
--
-- Purpose:
--   `invalidated_by` references profiles(id) — a real `usr_` — so it can only
--   attribute human/agent-invoked invalidations (dashboard forget, review
--   resolve, the `forget` MCP tool all set it). The automatic hygiene scanner
--   writes directly and leaves `invalidated_by` NULL by design (a system job
--   has no `usr_`), which is why an auto-superseded memory shows no invalidation
--   source. These two columns record WHAT performed a system invalidation:
--   `invalidated_by_agent` (e.g. 'hygiene-scanner') and, for success analysis,
--   `invalidated_by_model` (the judge model that made the call). Human paths
--   leave them NULL — `invalidated_by` carries the attribution there.
--
-- Affected objects:
--   - column public.memories.invalidated_by_agent (new, nullable)
--   - column public.memories.invalidated_by_model (new, nullable)
--   - data backfill: agent tag for existing system invalidations
--
-- Special considerations:
--   - Plain text, not FKs: these name a background actor / model string, not a
--     row — the `usr_` FK is `invalidated_by`, unchanged.
--   - Backfill is safe: every human/agent path sets `invalidated_by`, so a row
--     that is invalidated with `invalidated_by IS NULL` can only be the hygiene
--     scanner. The model is unknown for history, so it stays NULL.

alter table public.memories
  add column if not exists invalidated_by_agent text,
  add column if not exists invalidated_by_model text;

comment on column public.memories.invalidated_by_agent is
  'System actor that invalidated this memory (e.g. ''hygiene-scanner''). NULL '
  'when a human/agent path did it — that attribution is in invalidated_by.';
comment on column public.memories.invalidated_by_model is
  'Model that decided a system invalidation (judge model), for success '
  'analysis. NULL for human paths and for pre-attribution history.';

-- Backfill the actor for existing system invalidations. invalidated_by IS NULL
-- with invalidated_at set can only be the scanner (every human path attributes
-- invalidated_by), so this is a correct inference. The model is not recoverable
-- for history and is left NULL.
update public.memories
set invalidated_by_agent = 'hygiene-scanner'
where invalidated_at is not null
  and invalidated_by is null
  and invalidated_by_agent is null;
