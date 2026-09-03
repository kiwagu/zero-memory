-- Migration: revoke support for rule_candidates (rules incubator)
--
-- Purpose:
--   A promoted rule (one the owner applied to their always-on rules file) can
--   later prove unneeded. This adds an owner-initiated REVOKE: the rule leaves
--   the active state, the owner records WHY, and the incubator does not
--   re-propose it — a revoked rule stays terminal, like dismissed.
--
-- Affected objects:
--   - table public.rule_candidates: new status value 'revoked', columns
--     revoked_at + revoke_reason.
--
-- Special considerations:
--   - Additive and data-safe: the CHECK is widened (every existing status
--     stays valid) and the new columns are nullable. No RLS change — the
--     existing "owners resolve their rule candidates" UPDATE policy already
--     gates a revoke (still the owner's own memory).
--   - The detection rollup (find_rule_candidates) excludes any memory that has
--     a rule_candidates row regardless of status, so a revoked rule is already
--     never re-proposed — no rollup change needed.

set search_path = public;

-- 1. widen the status domain to include 'revoked' ---------------------------

alter table public.rule_candidates
  drop constraint if exists rule_candidates_status_check;
alter table public.rule_candidates
  add constraint rule_candidates_status_check
  check (status in ('pending', 'promoted', 'dismissed', 'snoozed', 'revoked'));

-- 2. revoke evidence ---------------------------------------------------------

-- When the owner pulled the rule back out of their always-on layer, and the
-- free-text reason they gave (kept for the audit trail).
alter table public.rule_candidates
  add column if not exists revoked_at timestamptz,
  add column if not exists revoke_reason text;
