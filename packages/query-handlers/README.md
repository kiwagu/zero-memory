# `@workspace/query-handlers`

Handlers for every query in `@workspace/queries`: thin classes that forward
into `MemoryService`.

## Role in the architecture

Application layer. Depends on `@workspace/queries`, `@workspace/cqrs`, and
`@workspace/memory`. The app host (`apps/server`) calls `registerQueries` at
startup.

## Key exports

- `registerQueries(container?)` — registers all handlers on the `QueryBus`.
- Handlers: `RecallQueryHandler`, `BuildContextQueryHandler`,
  `ListEntitiesQueryHandler` (plus the `queryHandlers` array).
