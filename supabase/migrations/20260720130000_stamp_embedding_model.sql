-- Migration: stamp the embedding model on every embedded row
--
-- Purpose:
--   Record WHICH model produced each stored vector. The two embedded tables
--   (memories.embedding, entities.name_embedding) carried no such marker, yet
--   the corpus has already been re-embedded twice (multilingual -> English e5,
--   384 -> 1024 dims). During a rolling re-embed a mixed state — some rows on
--   the old model, some on the new — is invisible without this column, and a
--   partial re-embed campaign has no safe way to tell which rows it still owes.
--   The stamp makes the mix observable and makes partial campaigns safe.
--
-- Affected objects:
--   - column public.memories.embedding_model (new, not null, defaulted)
--   - column public.entities.embedding_model (new, not null, defaulted)
--
-- Special considerations:
--   - The default IS the source of the stamp. Steady-state inserts inherit the
--     current model from the column default; there is no second code path to
--     keep in sync. The history is homogeneous today (one model everywhere), so
--     the fast default backfills every existing row with the honest value —
--     this is the last moment that backfill is truthful, which is why the
--     column is added now rather than after the corpus goes mixed.
--   - A model change is always a migration event (a new vector column + a
--     re-embed campaign). That same migration updates this default and stamps
--     the rows it re-embeds; nothing here has to anticipate the new name.
--   - Kept off the aggregates (usage_daily) by design: eval_runs already
--     carries an engine-version field, so the engine identity is not duplicated
--     onto rollups that do not hold vectors.

set search_path = public;

-- Xenova/e5-large-v2 — the model behind every current vector (packages/embedding
-- e5.service.ts MODEL_ID). Changing the model re-points this default in the
-- same migration that re-embeds.
alter table public.memories
  add column embedding_model text not null default 'Xenova/e5-large-v2';

alter table public.entities
  add column embedding_model text not null default 'Xenova/e5-large-v2';

comment on column public.memories.embedding_model is
  'Model that produced public.memories.embedding. Defaulted to the current '
  'model so new rows self-stamp; a re-embed campaign updates this alongside the '
  'vector it recomputes.';

comment on column public.entities.embedding_model is
  'Model that produced public.entities.name_embedding. Defaulted to the current '
  'model so new rows self-stamp; a re-embed campaign updates this alongside the '
  'vector it recomputes.';
