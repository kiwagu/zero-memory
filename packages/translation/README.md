# `@workspace/translation`

Language canonicalization: stored memory content is standardized on English,
while a non-English write returns immediately and is translated
**asynchronously**.

## Role in the architecture

Infrastructure adapter + worker. `@workspace/memory` detects language and
records `translation_status`, then starts a fire-and-forget canonicalization
for a new pending row. This package also drains failures/backlog out of band.
It depends on `@workspace/embedding` (re-embed), `@workspace/memory` (the
shared detector), `@workspace/persistence` (service-role worker client), and
the multi-provider LLM gateway.

## Key exports

- `ITranslator` / `TranslationResult` — the port: `translateToEnglish(text)`
  returns `{ text, sourceLang }` (English rendering + detected source language).
- `LlmTranslator` — model-backed adapter (forced tool use; vendor decided per
  call via the LLM gateway / BYO-key). Reads the platform `ANTHROPIC_API_KEY`
  lazily as the default; model override `ZM_TRANSLATOR_MODEL`.
- `DeterministicTranslator` (`@workspace/translation/testing`) — no-op double
  for key-free smoke / e2e.
- `TranslationWorker` — the two-pass worker:
  - `classify()` — model-free; flips not-yet-translated rows to `pending`
    (non-English) or `skipped` (English) using the write-path detector. Turns
    the pre-existing backlog into a queue.
  - `translate()` — paid; drains `pending` rows: translate → preserve the
    original in `content_original` → `content` becomes English →
    `content_lang` is the reported source → re-embed → `done`. Failures record
    an attempt and stay `pending` for a later run (bounded by `maxAttempts`).
  - `run()` — `classify()` then `translate()`.
  - A `dryRun` previews both with no model call and no write.

## How it runs

- Immediately after a non-English write: fire-and-forget translation under the
  caller's request context; failure leaves the row `pending`.
- Nightly cron: opt-in `startTranslationScheduler` on the server (mirrors the
  hygiene scheduler; disabled unless its interval env is set).
- On demand: `bun scripts/translate-pending.ts` (supports `--dry-run` and
  `--classify`), for the one-time backlog drain with a dry run first.
