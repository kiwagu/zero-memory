-- Migration: owner-pinned rules — a guaranteed touch of every session
--
-- Purpose:
--   Delivery of promoted rules is bounded on every channel: clients hard-cap
--   the MCP `instructions` budget, and the briefing caps how many rules it
--   carries. Once an owner accumulates dozens of rules, ranking decides what
--   gets dropped — and the rules that matter most are exactly the ones that
--   must never be. `pinned` is the owner's explicit "this one always reaches
--   the session" flag: a pinned rule is exempt from the delivery cap and the
--   delivery TTL, and it is delivered FIRST — leading the briefing's rules[]
--   with its own flag, where the model's attention is warmest.
--
-- Affected objects:
--   - table: public.rule_candidates (+ pinned boolean)
--
-- Special considerations:
--   - Additive with a default: existing rows are unpinned and keep their
--     current delivery order (newest-first). RLS/policies unchanged — the
--     owner already updates their own rows; the flag rides those policies.
--   - Applies to BOTH layers: a General rule (delivered to every session) and
--     a project rule (delivered in its project's briefings) are capped the
--     same way, so either can be pinned.

set search_path = public;

alter table public.rule_candidates
  add column pinned boolean not null default false;

comment on column public.rule_candidates.pinned is
  'Owner-pinned delivery of a promoted rule: exempt from the delivery cap '
  'and TTL, and delivered FIRST — leading the briefing rules[] with its own '
  'flag so the model''s attention lands on it first. The guarantee is that '
  'the rule REACHES the session, on whichever channel that session uses.';
