# `@workspace/cqrs`

In-process CQRS buses: command, query, and event dispatch with
decorator-based handler binding.

## Role in the architecture

Application-layer infrastructure. Depends on `@workspace/domain` (message
base classes) and `@workspace/di`. The handler packages register into the
buses; the MCP adapter and app hosts dispatch through them.

## Key exports

- `CommandBus` / `QueryBus` — resolve the one handler for a message (by
  metadata set at decoration time) and execute it; throw
  `CommandHandlerNotFoundException` / `QueryHandlerNotFoundException`
  otherwise.
- `EventBus` — `publish` / `publishMany`; unknown events are ignored.
- Decorators: `commandHandler(Command)`, `queryHandler(Query)`,
  `eventHandler(Event)` — mark a class as the handler of a message type.
- Types: `ICommandBus`, `IQueryBus`, `IEventBus`, `ICommandHandler`,
  `IQueryHandler`, `IEventHandler`, handler class types.

Handlers are resolved through the DI container at registration time, so their
constructor injection works normally.
