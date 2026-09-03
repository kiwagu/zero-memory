-- Migration: restore the partial predicate on the memories HNSW index
--
-- Purpose:
--   20260709170000 rebuilt both hot memory search indexes as PARTIAL
--   `where (invalidated_at is null)` so the ANN and fts scans never pay for
--   superseded/invalidated history. One day later, 20260710190000 (the
--   1024-dim re-embed) had to drop memories_embedding_hnsw_idx to retype the
--   vector column and recreated it WITHOUT the predicate — so ever since, the
--   HNSW index has been indexing dead rows again while the GIN fts index kept
--   the predicate. This restores the partial predicate on the HNSW index.
--
-- Affected objects:
--   - index public.memories_embedding_hnsw_idx  (dropped + recreated partial)
--
-- Special considerations:
--   - memories_fts_gin_idx is untouched: it is already partial (the re-embed
--     migration never dropped it).
--   - Plain DROP + CREATE (not CONCURRENTLY): migrations run in a transaction
--     and this project resets+reseeds, so rebuild cost is not a concern.
--   - Every ANN call site (search_memories, find_similar_memory,
--     find_review_candidates, build_context) filters `invalidated_at is null`,
--     matching the partial predicate exactly, so the planner keeps using the
--     index.
--   - Lesson recorded: a migration that drops + recreates an index must carry
--     over the existing predicate; check pg_indexes before authoring.

set search_path = public, extensions;

drop index if exists public.memories_embedding_hnsw_idx;

create index memories_embedding_hnsw_idx
  on public.memories
  using hnsw (embedding extensions.vector_cosine_ops)
  where (invalidated_at is null);

comment on index public.memories_embedding_hnsw_idx is
  'ANN over ACTIVE memories only (partial: invalidated_at is null) — dead '
  'history stays out of every hybrid-search vector scan.';
