# `@workspace/queries`

Query message classes for every read operation — logic-free DTOs whose props
mirror the tool input schemas in `@workspace/contracts`.

## Role in the architecture

Application-layer messages. Depends on `@workspace/domain` (the `Query`
base) and `@workspace/contracts`. Constructed by the MCP adapter
(`@workspace/mcp`) and handled in `@workspace/query-handlers`.

## Key exports

- `RecallQuery` — hybrid memory search (scopes, kinds, k, optional graph).
- `BuildContextQuery` — one-call context briefing for a topic.
- `ListEntitiesQuery` — list/search knowledge-graph entities.
