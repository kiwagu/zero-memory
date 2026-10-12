# `@workspace/logger`

Minimal structured JSON-line logger, dependency-free.

## Role in the architecture

Shared kernel. No workspace dependencies; used by almost every package and
app for one-line-per-entry JSON logs.

## Key exports

- `createLogger(name, bindings?)` — returns a `Logger` with
  `debug` / `info` / `warn` / `error` and `child(bindings)`.
- `setLogContextResolver(resolver)` — register a source of ambient fields (e.g.
  a correlation id from an `AsyncLocalStorage`) merged into every entry; keeps
  this package a leaf while logs still carry request context. Explicit bindings
  win on key collision.
- `runDetached(task, logger, message, context?)` — starts a side write without
  awaiting it; a rejection or a synchronous throw is logged at warn (with the
  context and the error message) and dropped, never thrown into the caller.
  `recordUsage` (`@workspace/usage`) and `recordAudit` (`@workspace/audit`)
  are thin wrappers over it; its fire-and-forget contract is tested here, once
  (`src/run-detached.spec.ts`).
- `drainDetached(timeoutMs)` — waits for every write `runDetached` started,
  up to the timeout, and returns how many were still pending. Only a runtime
  that freezes the process once a response is out (a serverless function)
  needs it; it drains before handing the response over.
- `runInBackground(task, work, logger, message, context?)` — starts work that
  outlives the request (a model-backed check of a new memory, a full hygiene
  scan). `work` runs here, detached, unless a runtime installed a dispatcher
  with `dispatchBackgroundTo(dispatcher)`: then `task`, the same work as data
  (`{ kind, args }`), is handed to it and `work` never runs here. Either way
  the drain waits for it; it never rejects, logs a failure at error, and
  resolves when the work or the hand-off ends. The server's AWS Lambda entry
  installs a dispatcher that sends the task to a worker function.
- Types: `Logger`, `LogLevel`, `LogContext`, `LogContextResolver`.

## Environment variables

| Variable     | Purpose                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`  | Minimum level: `debug`, `info` (default), `warn`, `error`                                                      |
| `LOG_STDERR` | `1` sends every level to stderr — required by stdio transports (e.g. MCP) where stdout carries protocol frames |
