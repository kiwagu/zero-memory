-- Migration: explicit project address of a promoted rule
--
-- Purpose:
--   A rule's delivery scope so far derived ONLY from its anchor memory's
--   scope. That leaves a boundary that is easy to miss: a rule distilled
--   from a PERSONAL-scope memory lands in the 'user' (general) layer and
--   loads in EVERY session, even when the rule is clearly about one
--   project. `applies_scope` is the explicit address set at promotion: for
--   a project-layer rule it names the project scope the rule binds to,
--   overriding the anchor-scope derivation (which stays the fallback).
--
-- Affected objects:
--   - table: public.rule_candidates (+ applies_scope, nullable ltree)
--
-- Special considerations:
--   - Nullable and additive: existing rows keep deriving from the anchor
--     memory's scope. RLS/policies unchanged (column rides existing rows).

set search_path = public, extensions;

alter table public.rule_candidates
  add column applies_scope extensions.ltree;

comment on column public.rule_candidates.applies_scope is
  'Explicit delivery scope of a promoted project-layer rule (set at '
  'promotion). Null = derive from the anchor memory''s scope. Lets a rule '
  'distilled from a personal-scope memory be ADDRESSED to the project it is '
  'clearly about, instead of leaking into the general (every-session) layer.';
