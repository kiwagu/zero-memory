# `@workspace/board`

The project board: cards that say what work is being done, where it stands,
and which artifacts it is made of.

A card sits between an open loop and a memory. A loop is a pointer that waits
to be consumed and ages out in days; a memory is one atomic fact that lives
for months. Work that runs for weeks fits neither, and a card is its
container — a document plus an append-only stream of what happened to it.

## Role in the architecture

Domain layer, one bounded context. It depends only on `@workspace/contracts`
and `oxide.ts`: no storage, no transport, no LLM. The aggregate decides what
a card will accept; adapters decide where the rows land.

Two invariants live here rather than in callers:

- **Every move carries a reason.** A state change with no stated
  justification is the unexplained transition the board exists to avoid, so
  the domain refuses one. This is also why no interface offers a drag
  gesture — there would be nowhere for the reason to come from.
- **State gates nothing.** Any state may follow any other, and no state
  blocks editing, attaching or noting. The board reports work; it never
  schedules it, claims it or hands it out.

Archiving is the single terminal act: it takes a card off the board and
freezes it. Reversible shelving is the `parked` state, which stays on the
board and moves back like any other.

## Key exports

- `Card` — the aggregate: `create`, `restore`, `edit`, `moveTo`, `archive`,
  `attach`, `detach`, `note`. Every mutation returns a `Result`, and a no-op
  (re-attaching the same target, an edit that changes nothing) succeeds
  without raising an event.
- `CardEventDraft` — what a change raises: identity, stream position, actor
  and timestamp are stamped when the event is stored, never invented here.
- `parseCardRef`, `cardRefKey`, `sameCardRef` — the closed reference
  vocabulary (memory, entity, thread, card, url) and the identity that makes
  attaching idempotent.
- `CardProps`, `CreateCardInput`, `EditCardInput`, `NoteCardInput`,
  `CardChange` — the shapes callers pass and receive.

Schemas, limits and the state vocabulary itself live in
`@workspace/contracts` (`card.schema.ts`), so storage checks and the tool
surface mirror one source.
