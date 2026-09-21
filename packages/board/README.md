# `@workspace/board`

The project board: cards that say what work is being done, where it stands,
and which artifacts it is made of.

A card sits between an open loop and a memory. A loop is a pointer that waits
to be consumed and ages out in days; a memory is one atomic fact that lives
for months. Work that runs for weeks fits neither, and a card is its
container — a document plus an append-only stream of what happened to it.

## Role in the architecture

Application layer, one bounded context: the card port, its failure
vocabulary, and the service in front of them. It depends only on
`@workspace/contracts` and the DI container — no storage, no transport, no
LLM.

Where each rule lives is deliberate. The STORE owns every invariant that
depends on a card's current state, because allocating a project-local number
and a stream position are read-modify-write races and a retried call must
land once — none of that survives being decided by one of several
applications talking to the same card. THIS package owns what can be decided
without the card, so a hopeless call never costs a round trip and the caller
gets a sentence rather than a code.

Two invariants shape everything else:

- **Every move carries a reason.** A state change with no stated
  justification is the unexplained transition the board exists to avoid, so
  the service refuses one before it travels and a check constraint refuses it
  again at the table. This is also why no interface offers a drag gesture —
  there would be nowhere for the reason to come from.
- **State gates nothing.** Any state may follow any other, and no state
  blocks editing, attaching or noting. The board reports work; it never
  schedules it, claims it or hands it out.

Archiving is the single terminal act: it takes a card off the board and
freezes it. Reversible shelving is the `parked` state, which stays on the
board and moves back like any other.

A card's **feed** is derived, never stored. Attaching a conversation (a
`thread` reference) binds it, and `readCard` then returns, beside the history,
the live memories that conversation wrote in the card's scope — computed at
read time from each memory's own provenance, under the reader's rights, and
without recording a recall. Detaching the conversation is the whole undo.

## Key exports

- `CardService` — the application service: `createCard`, `promoteLoop`,
  `editCard`, `moveCard`, `archiveCard`, `attachRef`, `detachRef`,
  `noteCard`, `readCard` (history and feed, each on its own cursor),
  `listBoard`, `resolveCard`. Every call returns a
  `Result`; a no-op (re-attaching the same target, an edit that changes
  nothing) is a success that reports `changed: false`.
- `ICardRepository`, `CARD_REPOSITORY`, `injectCardRepository` — the port and
  its DI token. One method per atomic store command.
- `CardFailure`, `toCardFailure`, `cardFailureToErrorCode` — why a call did
  not happen, and how that maps onto the transport's error vocabulary. Every
  state refusal is a `conflict`; the message keeps the specific reason.
- `parseCardRef`, `cardRefKey`, `sameCardRef`, `flattenCardRef` — the closed
  reference vocabulary (memory, entity, thread, card, url), the identity that
  makes attaching idempotent, and the flat pair the store keeps.

Schemas, limits and the state vocabulary itself live in
`@workspace/contracts` (`card.schema.ts`), so storage checks and the tool
surface mirror one source.
