# `@workspace/audit`

Audit-log port for command-bus mutations: one entry per command execution.

## Role in the architecture

Domain-layer port (shared kernel for auditing). Depends only on
`@workspace/di` and `@workspace/logger`. The composition-layer
`AuditedCommandBus` decorator (in `apps/server`) records through this port
around every `CommandBus.execute`; the generic `@workspace/cqrs` package is
never touched. The Supabase adapter (`@workspace/persistence` →
`SupabaseAuditRecorder`) writes to the deny-all `public.audit_log` under the
service role, stamping actor (`usr_`), request id, and author kind from the
ambient context. Queries do not pass through the command bus, so they are never
audited.

## Key exports

- `IAuditRecorder` / `AUDIT_RECORDER` / `injectAuditRecorder()` — the port, its
  DI token, and inject decorator.
- `recordAudit(recorder, event)` — fire-and-forget emit: not awaited and never
  throws into the caller, so auditing can never break or change the outcome of
  the command it records.
- `sanitizeCommandPayload(command)` — turns a command instance into a safe,
  size-bounded payload: every string field is clipped to `MAX_STRING_LENGTH`
  (500), and if the result still exceeds `MAX_PAYLOAD_BYTES` (8 KB) it collapses
  to `{ truncated: true, command_keys: [...] }`. Commands hold no secrets by
  construction, but memory content can be large, so the caps are mandatory.
- `AuditEvent`, `AuditOutcome`, `AuthorKind` — the event shape and enums
  (`ok` / `error`; `human` / `agent`).
