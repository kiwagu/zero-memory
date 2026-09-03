# `@workspace/embedding`

Embedding port and its local ONNX adapter: turns texts into fixed-size
vectors for hybrid search and entity resolution.

## Role in the architecture

Port + infrastructure adapter. Depends on `@workspace/di`,
`@workspace/logger`, and `@huggingface/transformers`. `@workspace/memory`
consumes the port; the app host binds the adapter.

## Key exports

- `IEmbeddingService` — the port: `dims` and `embed(texts, kind?)`, where
  `kind` is `'query' | 'passage'` (the e5 prefix; defaults to `'query'`).
- `EMBEDDING_SERVICE`, `injectEmbeddingService()` — DI token and helper.
- `E5SmallEmbeddingService` — transformers.js (ONNX) adapter, model
  `Xenova/e5-large-v2` (intfloat/e5-large-v2), 1024 dims. English-specialized,
  which is what stored content is canonicalized to. Prepends the e5
  `query:`/`passage:` prefix, mean-pools, and L2-normalizes. Downloads the
  model once into the cache dir and initializes lazily on first use.
- `passageSegments(content)`, `overflowWindowCount(content)`,
  `passageCoverageShortfall(content)`, `EMBEDDING_WINDOW_CHARS`,
  `WINDOW_OVERLAP_CHARS`, `MAX_OVERFLOW_WINDOWS` — the input-window split
  described below.

## The input window, and why a long passage needs several vectors

The model reads a fixed **512-token** window and its tokenizer truncates to it
**silently** — no flag, no warning, no error. For English technical prose
(~4.5 characters per token) the cliff sits near 2300 characters, and anything
past it is simply absent from the vector.

Measured against real stored vectors: appending 459 characters of unrelated
text to a 2400-character body left the vector bit-for-bit identical, and a
probe cut from a long memory's own ending found its parent as the top hit 10%
of the time. A long passage is therefore not unfindable — only its **opening**
is findable.

`passageSegments` is the answer: it returns the texts to embed for one stored
passage — first the whole content (the **primary** vector, which the model
truncates as before), then as many **overflow windows** as the length needs,
each overlapping the previous one so no sentence falls between two of them.
Callers store the overflow vectors beside the primary one and let search score
each record by whichever of its windows is closest.

Coverage follows the length rather than a fixed count of vectors. Any answer
to "why two and not three" would be arbitrary, and the record needing a third
is exactly the one a fixed two would fail; the only fixed quantity is the
window, which belongs to the model. Measured on 40 long memories, findability
stops depending on **where** in the record a fact is stated:

| probe cut from | primary vector only | with overflow windows |
| -------------- | ------------------- | --------------------- |
| the opening    | 90% top-1           | 88% top-1             |
| the middle     | 90% top-1           | 93% top-1             |
| the ending     | 10% top-1           | 93% top-1             |

The windows of one record never compete for separate result slots: search
collapses them by taking the record's closest window, so a long memory
occupies one row with a better distance. What full coverage does cost is
topical reach — a fully searchable record matches more queries than one
searchable by its opening — and that is the accepted price of its knowledge
being reachable at all.

`MAX_OVERFLOW_WINDOWS` bounds the fan-out, since memory content has no length
limit of its own. Reaching it is reported by `passageCoverageShortfall`, never
swallowed: a record too long for the budget must SAY that its ending is
uncovered rather than quietly losing it.

## Environment variables

| Variable             | Purpose                                                 |
| -------------------- | ------------------------------------------------------- |
| `ZM_MODEL_CACHE_DIR` | Model cache dir (default `~/.cache/zero-memory/models`) |

## Testing subpath

`@workspace/embedding/testing` exports
`DeterministicHashEmbeddingService` — a test-only stub deriving unit-length
vectors from a text hash (identical texts → identical vectors). Never wire it
into production DI; it carries no semantics.
