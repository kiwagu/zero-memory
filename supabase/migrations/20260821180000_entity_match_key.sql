-- Migration: entity resolution matches on spelling, not on similarity
--
-- Purpose:
--   Entity resolution ran exact-name match -> COSINE over name embeddings at a
--   0.85 floor -> create. The fuzzy step existed to unify spelling variants
--   ("zero_memory" against "zero-memory"), but an embedding of a short opaque
--   label cannot see a digit, so it merged distinct subjects instead.
--
--   Measured on a production clone, and these numbers are why this exists:
--   the "same subject spelled differently" and "distinct subjects" populations
--   overlap completely. Distinct pairs reach 0.9886 (`resolve_conflict` against
--   `resolve_conflicts`) — HIGHER than every genuine spelling variant, whose
--   maximum is 0.9875. Excluding all distinct subjects needs a floor above
--   0.9886, which keeps none of the variants; the best floor that exists still
--   gets 7 of 35 pairs wrong, and the shipped 0.85 wrongly merges 18 of 20.
--   The consequence was not theoretical: of 1614 live entities, 808 (50.1%)
--   could no longer be created, and in the busiest scope 556 of 880 — so the
--   graph had effectively stopped accepting new subjects, and serial-numbered
--   families (record numbers, ports, ticket ids, release tags) froze outright.
--
--   `match_key` replaces that probe with something deterministic: the name
--   lowercased with every separator run removed. Over the whole corpus it
--   collides on exactly four pairs, and all four are genuine spelling variants
--   ("hygiene-scanner"/"HygieneScanner", "session-start"/"SessionStart",
--   "segmented control"/"SegmentedControl", "VS Code"/"VSCode"). No distinct
--   subject collides with another.
--
--   Deliberately conservative, matching the discipline the hygiene merge pass
--   already applies to itself: morphological pairs ("embeddings"/"embedding")
--   and synonyms ("PostgreSQL"/"Postgres") are NOT one key and stay separate
--   nodes. A wrong merge is silent and poisons the anchor a later session
--   reaches a decision by; fragmentation is visible and can be repaired.
--
--   NOT a uniqueness constraint. The four existing collisions are left for the
--   hygiene merge to collapse under its own audited procedure, and the column
--   only has to make the lookup indexed. The resolver computes the same key
--   itself and probes with it; if the two ever disagree on an exotic name the
--   probe simply misses and a node is created, which is the safe direction.
--
--   `name_embedding` is untouched — it still backs topic matching in
--   `build_context`.

alter table public.entities
  add column match_key text
  generated always as (
    lower(regexp_replace(btrim(name), '[[:space:]_-]+', '', 'g'))
  ) stored;

comment on column public.entities.match_key is
  'Resolution key: name lowercased with separator runs removed. Matches '
  'spelling variants of one subject and nothing else. Not unique — existing '
  'duplicates are the hygiene merge pass''s work.';

-- Resolution always probes inside one scope, so the scope leads the index.
create index entities_scope_match_key_idx
  on public.entities (scope, match_key);
