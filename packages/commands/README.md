# `@workspace/commands`

Command message classes for every write operation — logic-free DTOs whose
props mirror the tool input schemas in `@workspace/contracts`.

## Role in the architecture

Application-layer messages. Depends on `@workspace/domain` (the `Command`
base) and `@workspace/contracts`. Constructed by the MCP adapter
(`@workspace/mcp`) and handled in `@workspace/command-handlers`.

## Key exports

- `RememberCommand` — store one memory.
- `ShareMemoryCommand` — widen one memory to a shared scope.
- `LinkCommand` — connect two entities (by name) or two memories (by uuid).
- `ForgetMemoryCommand` — invalidate (never delete) one memory.
- `IngestConversationCommand` — feed one transcript chunk into the
  auto-population pipeline.
