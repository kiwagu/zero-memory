-- Migration: index the session marker carried in memory provenance
--
-- Purpose:
--   A memory written inside a conversation now carries that conversation's
--   thread token in its provenance `source` jsonb (key `thread`). The marker
--   is a POINTER, never content: it addresses the conversation so a fact can
--   be traced back to where it was born, without any transcript text ever
--   being stored server-side.
--
--   Its first reader is the clustering question "which other facts came out of
--   this same conversation" — a lookup by an exact token over one owner's
--   memories. Without an index that is a sequential scan plus a jsonb
--   extraction per row, on the table that grows fastest.
--
-- Affected objects:
--   - index public.memories_source_thread_idx (new)
--
-- Special considerations:
--   - No column is added: the marker rides the existing `source` jsonb, the
--     same container that already carries the transport session id. Nothing is
--     backfilled — memories written before this migration, and every write
--     with no conversation behind it (import, repo bootstrap, terminal
--     quick-capture, dashboard actions), simply carry no marker. That absence
--     is an honest state, not a gap to fill.
--   - PARTIAL by design: only rows that actually carry the key are indexed, so
--     the index stays proportional to conversation-born memories rather than
--     to the whole table, and unmarked rows cost nothing.
--   - An expression index on `source ->> 'thread'` (text) rather than a jsonb
--     containment index: every intended read is an equality match on one exact
--     token, which btree serves at a fraction of the size of a gin index over
--     the whole document.
--   - Read paths stay fenced by the existing memories RLS policies; this index
--     changes no privileges and no policy.

set search_path = public;

-- 1. index ---------------------------------------------------------------------

create index memories_source_thread_idx
  on public.memories ((source ->> 'thread'))
  where source ? 'thread';

comment on index public.memories_source_thread_idx is
  'Serves "other facts from the same conversation": equality lookups on the '
  'thread token stamped into a memory''s provenance source. Partial — only '
  'conversation-born memories carry the key.';
