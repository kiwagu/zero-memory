-- Migration: canonical-English memory content with preserved original
--
-- Purpose:
--   Memory content is standardized on English as its canonical language so that
--   the vector and full-text search legs are single-language. Cross-language
--   recall was silently missing non-English facts: an English query did not
--   surface a memory written in another language (e.g. 'es'), and the 'simple'
--   FTS tsvector cannot match across languages at all. Translation is DEFERRED,
--   not done on the write path:
--     - `content`             holds the best available text; it is the ORIGINAL
--                             until a translation lands, then the canonical English.
--     - `content_original`    the pre-translation source text, kept for audit,
--                             re-translation, and native-language display. NULL
--                             until a translation replaces `content` (and for
--                             rows that were already English — nothing to keep).
--     - `content_lang`        source language of the original text (e.g. 'en',
--                             'es'), reported by the translator. NULL while an
--                             untranslated non-English row waits in the queue.
--     - `translation_status`  'skipped' (already English — canonical as-is),
--                             'pending' (needs translation), 'done' (translated).
--     - `translation_attempts`/`translation_error` let the async worker retry a
--                             failed row a bounded number of times and surface why.
--
--   An out-of-band worker (nightly cron + on-demand) drains 'pending' rows:
--   translate -> move original into content_original -> content := English ->
--   re-embed -> status 'done'. The write path never calls a translation model.
--
-- Affected objects:
--   - columns public.memories.content_original / content_lang /
--     translation_status / translation_attempts / translation_error (all new)
--   - index memories_translation_pending_idx (partial, drives the worker queue)
--
-- Special considerations:
--   - No language backfill runs here. Classifying existing rows (which are
--     English vs which need translation) uses the same detector as the write
--     path and is done by the worker's classify pass, so there is one source of
--     truth and no language-specific SQL. New rows are classified on write.
--   - Existing rows therefore start at the column default 'skipped'; the
--     classify pass (dry-run first) flips the non-English ones to 'pending'
--     before any translation is attempted.
--   - The generated `fts` column recomputes from `content` automatically when a
--     translation rewrites it; only `embedding` must be recomputed by the worker.

alter table public.memories
  add column if not exists content_original text,
  add column if not exists content_lang text,
  add column if not exists translation_status text not null default 'skipped'
    check (translation_status in ('pending', 'done', 'skipped')),
  add column if not exists translation_attempts integer not null default 0,
  add column if not exists translation_error text;

comment on column public.memories.content_original is
  'Pre-translation source text, kept for audit / re-translation / native '
  'display. NULL until a translation replaces content (and for already-English '
  'rows). content holds the original until then, the English canonical after.';
comment on column public.memories.content_lang is
  'Source language of the original text (BCP-47-ish, e.g. ''en'', ''es''), '
  'reported by the translator. NULL while an untranslated non-English row waits.';
comment on column public.memories.translation_status is
  '''skipped'' = already English (canonical as-is); ''pending'' = awaiting the '
  'async translation worker; ''done'' = translated (content is English, '
  'content_original holds the source).';
comment on column public.memories.translation_attempts is
  'Times the async worker has tried to translate this row; bounds retries so a '
  'poison row cannot loop forever.';
comment on column public.memories.translation_error is
  'Last translation failure message (worker), for observability. NULL on '
  'success.';

-- Worker queue: only pending rows are scanned, oldest first. Partial so it stays
-- tiny once the backlog drains (steady state has few pending rows at a time).
create index if not exists memories_translation_pending_idx
  on public.memories (created_at)
  where translation_status = 'pending';
