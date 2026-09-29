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

## Testing

```sh
bun run test:vitest
```

`release.command-handler.spec.ts` owns the release handler's own rules: a
`configure` carries over every setting the call leaves out (the store
replaces the whole row) and clears the version URL only on an explicit
`null`; a `record` refuses `landing_seqs` that are not one per card before
anything is written, and names the field an action cannot do without. It runs
the real `ReleaseService` over a fake release repository.
