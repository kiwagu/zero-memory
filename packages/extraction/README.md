# `@workspace/extraction`

Auto-population pipeline: turns raw conversation transcript chunks into
durable memories via an LLM extractor.

## Role in the architecture

Application layer + one infrastructure adapter. Depends on
`@workspace/memory` (memory/entity/graph services), `@workspace/context`,
`@workspace/contracts`, `@workspace/di`, `@workspace/logger`, and the LLM
gateway (`@workspace/llm`, vendor-agnostic). `@workspace/command-handlers` dispatches
`ingest_conversation` into it.

## Key exports

- `IExtractor` port + `EXTRACTOR` token / `injectExtractor()` — transcript
  chunk in, validated `ExtractionResult` out.
- `LlmExtractor` — one forced-tool-use call (vendor decided per call by the LLM
  gateway / BYO-key — no vendor in the name) whose tool schema mirrors
  `extractionResultSchema`; the result is re-validated with zod.
- `IngestService` — the pipeline: idempotency check (chunk hash), extraction
  gate, extraction, confidence gate (`CONFIDENCE_GATE` = 0.7), per-chunk quota,
  scope routing, dedup via the memory service, entity resolution and relation
  edges.
- `extraction-gate.ts` — the auto-ingest policy.
  - **Metrics-only** (`ZM_INGEST_EXTRACT`, **default `off`** =
    `resolveExtractionEnabled`): the chunk still travels the transport —
    claimed, metered, and scored by the usefulness judge — but nothing is
    extracted or stored. This is the STANDING posture (default, no env var
    needed): capture-of-value lives in the in-session agent's own deliberate
    `remember` (higher precision than post-hoc extraction), while ingest stays
    for measurement (recall usefulness / ROI). Set `ZM_INGEST_EXTRACT=on` to
    re-enable extraction (eval/debug). See **Future directions** below for the
    tracks to revisit extraction.
  - **Gate** (`ZM_INGEST_GATE`, default `off`): when extraction IS on, trims
    the noise. `assessChunk` skips the LLM for chunks with too little
    substantive prose (`MIN_SIGNAL_CHARS`); `assessCandidate` holds the noisy
    kinds (`NOISY_KINDS` = `fact`/`episode`) to a higher confidence bar
    (`NOISY_KIND_CONFIDENCE`) on the transcript path (bootstrap sources exempt).
    `enforce` acts, `shadow` only meters, `off` disables. The chunk verdict
    rides on the metered `ingest_chunk` event (`metadata.gate`, `metadata.extract`)
    so the effect is auditable without a new event type.
  - Neither touches the deliberate `remember` path.
- `IIngestLogRepository` port + `INGEST_LOG_REPOSITORY` token — the
  transport-idempotency ledger (one row per chunk hash).
- `IChunkBuffer` / `PassthroughChunkBuffer` — chunking seam; v1 processes
  every chunk immediately.
- `extraction.schema.ts` — `extractedMemorySchema`, `extractionResultSchema`
  and friends (boundary contracts, schema-first).

## Environment variables

| Variable                  | Purpose                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`       | Platform-default LLM key for `LlmExtractor` (per-user BYO-key overrides)       |
| `ZM_EXTRACTOR_MODEL`      | Model override (default `claude-haiku-4-5-20251001`)                           |
| `ZM_INGEST_MAX_MEMORIES`  | Max memories stored per chunk (default `10`)                                   |
| `ZM_INGEST_BUFFER_TOKENS` | Buffer flush budget; `0` (default) = process immediately                       |
| `ZM_INGEST_EXTRACT`       | `off` (default) = metrics-only; `on` re-enables extraction                     |
| `ZM_INGEST_GATE`          | Extraction gate (only when extracting): `off` (default) / `shadow` / `enforce` |

## Testing subpath

`@workspace/extraction/testing` exports `DeterministicExtractor` — a
keyword-driven, model-free extractor for smoke tests (`DECISION: ...`,
`FACT: ... [[entity:name|type]]`). The server enables it via
`ZM_EXTRACTOR=deterministic`. Never wire it into production DI.

`bun run test:vitest` runs the package specs.

## Future directions — revisiting extraction

Extraction is **off by default** (metrics-only) because post-hoc extraction of
chat by a weak model was low-precision (audited: ~0.2% of ingest-born memories
were ever reused, vs ~20% of deliberate `remember`). If extraction is revisited,
the two highest-leverage levers come first — they also remove the "tuning locks
prod" problem:

1. **Locus — move authoring in-session.** The biggest win is not a better
   post-hoc extractor but letting the strong in-session model author memories
   at the moment, with full context (proactive `remember`), or flagging spans
   the server then extracts (hybrid). Higher precision than out-of-context
   post-hoc.
2. **Measurement harness removes the prod lock.** Tune extraction OFFLINE
   against a fixed holdout (`eval_runs`, `scripts/search-eval.ts`, the ROI
   holdout) + `shadow` mode + a live→e2e clone, and promote only what wins (an
   engine-dev loop). Then none of the below touches serving.

Then, per axis:

- **Input selection:** salience/novelty (skip re-extracting what the corpus
  already holds — dedup-before-extract by embedding), event triggers
  (decisions/errors/corrections), the deterministic pre-filter (the gate).
- **Model/prompt:** Haiku→Sonnet (`thinking: disabled`), few-shot on the
  owner's real good/bad memories, multi-provider (AI SDK), self-critique /
  two-pass verify-before-store.
- **Acceptance calibration:** learn the confidence/kind bars from `recall_used`
  / reinforcement (accept what actually gets reused) — close the loop.
- **Dedup/merge at write:** supersede-at-write (return supersede candidates in
  the `remember` response), extract-then-merge — cuts churn and the hygiene tax
  at the source.
- **Curation:** route candidates through an approve queue (like the reflection /
  rule-candidate queues) instead of auto-write — high precision, low volume.

Existing building blocks: the gate (pre-filter), the reflection / rule-candidate
queues, `eval_runs` + holdout + `search-eval`, the `recall_used` / reinforcement
signal, BYO-key / multi-provider.
