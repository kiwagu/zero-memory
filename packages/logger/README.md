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
- Types: `Logger`, `LogLevel`, `LogContext`, `LogContextResolver`.

## Environment variables

| Variable     | Purpose                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`  | Minimum level: `debug`, `info` (default), `warn`, `error`                                                      |
| `LOG_STDERR` | `1` sends every level to stderr — required by stdio transports (e.g. MCP) where stdout carries protocol frames |
