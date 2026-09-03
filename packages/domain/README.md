# `@workspace/domain`

DDD building blocks: base classes for aggregates, entities, value objects,
events, commands, queries, and specifications.

## Role in the architecture

Shared kernel of the domain layer. Depends only on small utility libraries
(`zod`, `oxide.ts`, `nanoid`, `dequal`); the domain (`@workspace/memory`),
CQRS, and message packages build on it. It contains no zero-memory-specific
logic.

## Key exports

- `AggregateRoot` — entity base with a domain-event queue.
- `Entity` / `ValueObject` — identity vs. structural-equality bases.
- `ID`, `IdFactory(prefix)` — prefixed nanoid identifier value objects.
- `Command`, `CommandProps` / `Query`, `QueryProps` — message base classes.
- `BaseEvent`, `IEvent` — domain event base.
- `ExceptionBase`, `SerializedException` — serializable exception base.
- `Mapper` — domain ⇄ persistence ⇄ DTO mapping interface.
- `CompositeSpecification`, `And`/`Or`/`Not`, `and`/`or` — specification
  pattern with visitor support.
