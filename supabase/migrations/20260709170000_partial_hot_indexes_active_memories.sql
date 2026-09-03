-- Migration: make the hot memory search indexes partial (active rows only)
--
-- Purpose:
--   memories is an ADD-only store: superseded / invalidated rows are never
--   deleted, they accumulate with invalidated_at set. The two hot search
--   indexes were FULL, so the HNSW (embedding) and GIN (fts) indexes kept
--   indexing dead rows. Every hybrid search (recall / build_context) and every
--   write-path probe (find_similar_memory, find_review_candidates) filters
--   `invalidated_at is null`, then discards the dead candidates the index scan
--   returned -- work that grows in proportion to accumulated history.
--
--   Rebuilding both indexes as PARTIAL `where (invalidated_at is null)` makes
--   them cover only active rows. The table still grows with history, but the
--   query planner never pays for the dead tail: the partial predicate matches
--   the callers' `invalidated_at is null` predicate exactly, so the planner
--   keeps using these indexes for the ANN order-by and the fts match.
--
-- Affected objects:
--   - index public.memories_embedding_hnsw_idx  (dropped + recreated partial)
--   - index public.memories_fts_gin_idx         (dropped + recreated partial)
--
-- Special considerations:
--   - No column changes: valid_from / invalidated_at already model validity
--     (invalidated_at is null == the currently-valid version). We deliberately
--     do NOT add valid_from/valid_to duplicates.
--   - History remains fully queryable: version-history lookups walk the
--     superseded_by chain by id, never the ANN / fts indexes, so dropping dead
--     rows from these two indexes loses nothing.
--   - Rebuild is plain DROP + CREATE (not CONCURRENTLY): migrations run inside
--     a transaction and this project resets+reseeds (no live prod instance), so
--     the table is empty at apply time and the rebuild is instant.

set search_path = public, extensions;

-- 1. embedding: approximate nearest-neighbour over active rows only ----------

drop index if exists public.memories_embedding_hnsw_idx;

create index memories_embedding_hnsw_idx
  on public.memories
  using hnsw (embedding extensions.vector_cosine_ops)
  where (invalidated_at is null);

-- 2. fts: full-text search over active rows only -----------------------------

drop index if exists public.memories_fts_gin_idx;

create index memories_fts_gin_idx
  on public.memories
  using gin (fts)
  where (invalidated_at is null);
