# `@workspace/contracts`

Zod schemas for every boundary of the system: MCP tool inputs/outputs, memory
vocabulary, and knowledge-graph shapes (schema-first contracts).

## Role in the architecture

Shared kernel. Depends only on `zod`; nearly every other package depends on
it. Types are inferred from the schemas — there are no hand-written duplicate
interfaces.

## Key exports

- `tools.schema.ts` — input/output schemas (and inferred types) for the full
  MCP surface: memory writes/reads, ingest/import/export, graph and sharing,
  lifecycle/open loops, hygiene conflict review, rules, metrics, scope
  description, and account deletion.
- `memory.schema.ts` — memory vocabulary: `memoryKindSchema`,
  `memoryScopeSchema`, `memoryVisibilitySchema` (`private` / `shared`),
  `memoryAuthorKindSchema`, `memoryLinkTypeSchema`.
- `graph.schema.ts` — entity/edge vocabulary: `entityTypeSchema`,
  `edgeTypeSchema`, `entityMentionSchema`, plus the context/graph result
  shapes (`entityHitSchema`, `contextEntitySchema`, `contextEdgeSchema`,
  `contextMemorySchema`).
- `contract-version.ts` — `CONTRACT_VERSION`, the semver of the tool/response
  contract itself (currently `2.0.0`, independent of package versions). The
  MCP server announces it at
  `capabilities.experimental["zero-memory/contract"].version`; removals are
  listed in `docs/DEPRECATIONS.md`.
- `error.schema.ts` — the failure vocabulary: `errorCodeSchema` (seven codes),
  the `toolErrorSchema` body `{error:{code,message,details?}}`,
  `ERROR_CODE_HTTP_STATUS`, and `errorCodeOf` for reading a code off a thrown
  value. Every tool and every route this system owns answers in this shape;
  the OAuth endpoints (RFC 6749/6750) and `/mcp` (JSON-RPC) keep the shapes
  their own specs prescribe.

  The same file carries the code from the point that knows the failure class
  to the boundary that reports it: `Failure` (`{code, message}`) with the
  helpers `validationFailed` / `notFound` / `conflictFailure` / `forbidden` /
  `internalFailure` for services that answer with a `Result`, and
  `FailureError` for handlers that answer by throwing. Without that carrier a
  service could only return prose, so the boundary had to fall back to
  `internal` — telling a caller "nothing you can do" about a rejection it
  could have fixed by rewriting its input.

## Testing

`bun run test:vitest` — schema round-trip specs live next to the schemas.
