-- Migration: a rule says when it applies, and which guard enforces it
--
-- Purpose:
--   Standing rules are about to be delivered at a level chosen per call by a
--   decision model: a rule that binds the task arrives in full, a rule that
--   does not arrives by headline. The model judges applicability, so a rule
--   needs to state its applicability as data — observable features of a task
--   ("any task that changes files under git") — instead of leaving it buried
--   in a paragraph of imperative text. Some rules are also enforced by a
--   client-side guard hook; naming that guard lets delivery quality be
--   measured against the guard's refusals without any labelling.
--
-- Affected objects:
--   - table public.rule_candidates (+ applies_when text, + enforced_by text)
--
-- Special considerations:
--   - Additive, nullable: existing rows keep working; a rule without
--     applies_when is judged on its full text until the owner or the
--     distiller fills the field.
--   - RLS unchanged: the owner already updates their own rows (the /rules
--     page sets pinned the same way); both new columns ride those policies.

set search_path = public;

alter table public.rule_candidates
  add column applies_when text
    check (applies_when is null or length(applies_when) <= 400),
  add column enforced_by text
    check (enforced_by is null or enforced_by ~ '^[a-z][a-z0-9_-]{1,63}$');

comment on column public.rule_candidates.applies_when is
  'When this rule binds a task, as one to three lines of observable task '
  'features. Read by the delivery judge as the condition to test against the '
  'task description, and shown to the agent as the gate between the headline '
  'and the full text.';

comment on column public.rule_candidates.enforced_by is
  'Name of the client-side guard hook that mechanically enforces this rule, '
  'when one exists (the tag the hook prints in its refusal reason). Joins the '
  'guard''s refusals to the rule for delivery-quality measurement.';
