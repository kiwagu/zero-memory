# `@workspace/command-handlers`

Handlers for every command in `@workspace/commands`: thin classes that
validate/forward into the application services.

## Role in the architecture

Application layer. Depends on `@workspace/commands`, `@workspace/cqrs`,
`@workspace/memory` (`MemoryService`), and `@workspace/extraction`
(`IngestService`). The app host (`apps/server`) calls `registerCommands` at
startup.

## Key exports

- `registerCommands(container?)` — registers all handlers on the
  `CommandBus`.
- Handlers: `RememberCommandHandler`, `ShareMemoryCommandHandler`,
  `LinkCommandHandler`, `ForgetMemoryCommandHandler`,
  `IngestConversationCommandHandler` (plus the `commandHandlers` array).
