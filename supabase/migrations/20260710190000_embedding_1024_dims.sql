-- Migration: widen embedding vectors from 384 to 1024 dimensions
--
-- Purpose:
--   Canonical-English storage removed the multilingual constraint on the
--   embedding model, so the app moves from the multilingual e5-small (384 dims)
--   to the stronger English e5-large-v2 (1024 dims). That is a NEW vector space:
--   old 384-dim vectors are meaningless to the new model AND do not fit the
--   wider column, so they are cleared here and recomputed by the re-embed job.
--
-- Affected objects:
--   - column public.memories.embedding        vector(384) -> vector(1024)
--   - column public.entities.name_embedding   vector(384) -> vector(1024)
--   - HNSW indexes on both columns (dropped, recreated)
--   - data: both embedding columns are cleared (set NULL)
--
-- Special considerations:
--   - Search/graph functions take a `vector(384)` PARAMETER, but Postgres does
--     not enforce a typmod on function parameters (verified: a vector(384) param
--     accepts a 1024-dim argument), so none of them need to change — only the
--     column typmods carry the real dimension.
--   - Recall is degraded (no vectors) between this migration and the re-embed
--     pass; the FTS leg still works. Run the re-embed immediately after.
--   - Existing 384-dim values must be cleared first: `alter type vector(1024)`
--     cannot cast a 384-dim value, and the ANN index depends on the column, so
--     the index is dropped first too.

set search_path = public, extensions;

-- 1. drop the ANN indexes (they depend on the vector columns) ------------------
drop index if exists public.memories_embedding_hnsw_idx;
drop index if exists public.entities_name_embedding_hnsw_idx;

-- 2. clear the now-invalid 384-dim vectors ------------------------------------
update public.memories set embedding = null where embedding is not null;
update public.entities set name_embedding = null where name_embedding is not null;

-- 3. widen the columns to the new model's dimensionality ----------------------
alter table public.memories
  alter column embedding type extensions.vector (1024);
alter table public.entities
  alter column name_embedding type extensions.vector (1024);

-- 4. recreate the ANN indexes (empty until the re-embed repopulates) ----------
create index memories_embedding_hnsw_idx
  on public.memories
  using hnsw (embedding extensions.vector_cosine_ops);

create index entities_name_embedding_hnsw_idx
  on public.entities
  using hnsw (name_embedding extensions.vector_cosine_ops);
