-- Migration: ranked scope suggestions for rule_candidates (rules incubator)
--
-- Purpose:
--   A distilled rule often applies beyond the scope its source memory lives
--   in (several projects, or the owner's global personal layer). This adds a
--   ranked, NON-BINDING recommendation set per candidate: where the rule
--   likely belongs. The deterministic part (the origin scope, the personal
--   layer for user-scoped memories) is always correct; entries contributed by
--   the LLM distiller are explicitly speculative — the owner decides where to
--   actually paste the rule, the server never routes or writes files.
--
-- Affected objects:
--   - table public.rule_candidates: new column suggested_scopes (jsonb).
--
-- Special considerations:
--   - Additive and data-safe: nullable column, no CHECK/RLS change (the
--     content is derived, owner-visible metadata about the owner's own rule).
--   - Shape: jsonb array of { "scope": text, "score": 0..1, "source":
--     "origin" | "global" | "llm" } ordered by rank. Kept as jsonb (not a
--     relation): it is a display/recommendation payload, never joined on.

set search_path = public;

-- 1. ranked scope suggestions ------------------------------------------------

alter table public.rule_candidates
  add column if not exists suggested_scopes jsonb;

comment on column public.rule_candidates.suggested_scopes is
  'Ranked, non-binding recommendation of scopes where the distilled rule '
  'likely applies: [{scope, score, source: origin|global|llm}]. Deterministic '
  'entries (origin/global) are always correct; llm entries are speculative.';
