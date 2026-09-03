# `@workspace/di`

Dependency-injection facade: re-exports the used subset of `tsyringe` behind
one workspace import.

## Role in the architecture

Shared kernel. Every package that participates in DI imports `container`,
`inject`, `injectable`, `singleton`, tokens, etc. from here instead of from
`tsyringe` directly, and the single `import 'reflect-metadata'` side effect
lives here — nowhere else.

## Key exports

- Values: `container`, `inject`, `injectable`, `singleton`, `registry`,
  `Lifecycle`, `instanceCachingFactory`.
- Types: `DependencyContainer`, `InjectionToken`, `Provider`,
  `ClassProvider`, `FactoryProvider`, `ValueProvider`.
