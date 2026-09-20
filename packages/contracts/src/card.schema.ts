import { z } from 'zod';

import { entityIdSchemas } from './entity-prefixes.js';
import { entityIdSchema } from './graph.schema.js';
import { memoryIdSchema, memoryScopeSchema } from './memory.schema.js';
import { userIdSchema } from './user.schema.js';

/**
 * A card id: a branded `crd_` entity id (parsed, never a raw string).
 *
 * A CARD is the container of one piece of work — the document that says what
 * is being done, where it stands, and what it is made of. It sits between an
 * open loop (days, a pointer awaiting consumption) and a memory (months, one
 * atomic fact): work that runs for weeks had no home before it.
 *
 * What a card is NOT, and the contract enforces it: a card's state is a
 * DECLARATION, never a precondition for any server operation. Nothing is
 * dispatched, claimed, leased or blocked by it. The board is a reference for
 * whoever reads it next, not an execution engine.
 */
export const cardIdSchema = entityIdSchemas.card.schema;
export type CardId = z.infer<typeof cardIdSchema>;

/** Mint a fresh card id (trusted construction). */
export const newCardId = (): CardId => entityIdSchemas.card.create();

/** A card-event id: a branded `cev_` entity id. */
export const cardEventIdSchema = entityIdSchemas.card_event.schema;
export type CardEventId = z.infer<typeof cardEventIdSchema>;

/** Mint a fresh card-event id (trusted construction). */
export const newCardEventId = (): CardEventId =>
  entityIdSchemas.card_event.create();

/**
 * The conversation a card (or one of its events) is bound to. Binding a
 * thread is what makes a card's feed DERIVED: memories born in that
 * conversation appear on the card without anyone attaching them one by one.
 */
const cardThreadIdSchema = entityIdSchemas.session_thread.schema;

/**
 * Declarative states of a card.
 *
 * `waiting` means the work waits on a human or an outside event — the reason
 * why is carried by the move, not by the state. `parked` is the reversible
 * shelf; taking a card OFF the board is `archive`, which is a separate act.
 *
 * Any state may follow any other (a `done` card reopens into `active`, an
 * `idea` is parked without ever running). The vocabulary orders the board's
 * columns; it does not gate anything, so there is no transition table here.
 */
export const cardStateSchema = z.enum([
  'idea',
  'active',
  'waiting',
  'done',
  'parked',
]);
export type CardState = z.infer<typeof cardStateSchema>;

/** Kinds of event in a card's append-only stream. */
export const cardEventTypeSchema = z.enum([
  'created',
  'edited',
  'moved',
  'archived',
  'attached',
  'detached',
  'noted',
]);
export type CardEventType = z.infer<typeof cardEventTypeSchema>;

/**
 * How a note stands to the one it replies to. A note is its author's
 * statement — it is never a fact, a command, or a verdict, and reading one
 * does not oblige another agent to act on it.
 */
export const cardNoteRelationSchema = z.enum([
  'supports',
  'disputes',
  'corrects',
]);
export type CardNoteRelation = z.infer<typeof cardNoteRelationSchema>;

/**
 * Size ceilings for a card's text. They are the single source the storage
 * check constraints mirror, so a value can only be widened in one place.
 *
 * A body is far larger than a memory's cap on purpose: a memory is one atomic
 * fact, while a card is a document that states a goal and its boundaries.
 */
export const CARD_LIMITS = {
  title: 200,
  body: 8000,
  reason: 500,
  noteText: 4000,
  agentLabel: 80,
  url: 2048,
  idempotencyKey: 200,
} as const;

/** Card title: one line, never blank. */
export const cardTitleSchema = z
  .string()
  .trim()
  .min(1, { message: 'A card title must not be empty' })
  .max(CARD_LIMITS.title);

/** Card body: the Markdown document. May be empty; a title alone is a card. */
export const cardBodySchema = z.string().trim().max(CARD_LIMITS.body);

/**
 * The justification a move carries.
 *
 * Required and non-blank by construction: a state change without a stated
 * reason is exactly the unexplained transition the board must not contain,
 * which is also why the dashboard cannot move a card at all — there is no
 * drag gesture that could supply this.
 */
export const cardReasonSchema = z
  .string()
  .trim()
  .min(1, { message: 'A move must carry a reason' })
  .max(CARD_LIMITS.reason);

/** A note's text. */
export const cardNoteTextSchema = z
  .string()
  .trim()
  .min(1, { message: 'A note must not be empty' })
  .max(CARD_LIMITS.noteText);

/**
 * The agent name its author declares for itself. Metadata for the reader —
 * authority always comes from the authenticated principal, never from this.
 */
export const cardAgentLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(CARD_LIMITS.agentLabel);

/**
 * A client-supplied key that makes a retry after a network timeout land once.
 * Replaying the same key returns the first result; the same key with a
 * different payload is refused.
 */
export const cardIdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(CARD_LIMITS.idempotencyKey);

/**
 * A typed reference attached to a card.
 *
 * Attaching NEVER changes the target: not its scope, not its visibility, not
 * the entity graph, not an open loop's lifecycle. A reference is a pointer,
 * and every target is authorized per viewer when the feed is read — one a
 * viewer may not read renders as an id-only stub.
 *
 * There is deliberately no `loop` kind: an open loop IS a memory of kind
 * `task` or `open-question`, so it attaches as `memory`. A card's descent
 * from a loop is not an attachment at all — it is `originLoopId`, which
 * carries provenance and the guard that memory hygiene can never close a card
 * through the loop it came from.
 */
export const cardRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('memory'), id: memoryIdSchema }),
  z.object({ kind: z.literal('entity'), id: entityIdSchema }),
  z.object({ kind: z.literal('thread'), id: cardThreadIdSchema }),
  z.object({ kind: z.literal('card'), id: cardIdSchema }),
  z.object({ kind: z.literal('url'), url: z.url().max(CARD_LIMITS.url) }),
]);
export type CardRef = z.infer<typeof cardRefSchema>;

/** The kinds a reference may take, for storage checks and display. */
export const CARD_REF_KINDS = [
  'memory',
  'entity',
  'thread',
  'card',
  'url',
] as const;
export type CardRefKind = (typeof CARD_REF_KINDS)[number];

/** A card as it is read back. */
export const cardSchema = z.object({
  id: cardIdSchema,
  /** The project scope the card lives in; membership decides who reads it. */
  scope: memoryScopeSchema,
  /** Project-local number (`#42`); never reused once a card is archived. */
  number: z.number().int().positive(),
  title: cardTitleSchema,
  body: cardBodySchema,
  state: cardStateSchema,
  /** Bumped by every content edit; an edit may name the one it expects. */
  revision: z.number().int().nonnegative(),
  /** The loop this card was promoted from, when it was. */
  origin_loop_id: memoryIdSchema.nullable(),
  created_by: userIdSchema,
  created_at: z.string(),
  updated_at: z.string(),
  /** Set once the card leaves the board; an archived card is read-only. */
  archived_at: z.string().nullable(),
});
export type Card = z.infer<typeof cardSchema>;

/** Fields every event in the stream carries, whatever its type. */
const cardEventBase = {
  id: cardEventIdSchema,
  card_id: cardIdSchema,
  /** Position in the card's own stream: the order events were written. */
  seq: z.number().int().positive(),
  actor_id: userIdSchema,
  agent_label: cardAgentLabelSchema.nullable(),
  /** The conversation the event was written in, when one was asserted. */
  thread: cardThreadIdSchema.nullable(),
  created_at: z.string(),
};

/**
 * One event of a card's append-only stream.
 *
 * A discriminated union rather than a wide row of nullables, because the
 * shapes genuinely differ: a `moved` event without a reason must be
 * unrepresentable, and a `noted` event has no state at all.
 */
export const cardEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...cardEventBase,
    type: z.literal('created'),
    to_state: cardStateSchema,
    origin_loop_id: memoryIdSchema.nullable(),
  }),
  z.object({
    ...cardEventBase,
    type: z.literal('edited'),
    revision: z.number().int().positive(),
  }),
  z.object({
    ...cardEventBase,
    type: z.literal('moved'),
    from_state: cardStateSchema,
    to_state: cardStateSchema,
    reason: cardReasonSchema,
  }),
  z.object({
    ...cardEventBase,
    type: z.literal('archived'),
    reason: cardReasonSchema,
  }),
  z.object({
    ...cardEventBase,
    type: z.literal('attached'),
    ref: cardRefSchema,
  }),
  z.object({
    ...cardEventBase,
    type: z.literal('detached'),
    ref: cardRefSchema,
  }),
  z.object({
    ...cardEventBase,
    type: z.literal('noted'),
    text: cardNoteTextSchema,
    /** The event this note answers — always another note. */
    reply_to: cardEventIdSchema.nullable(),
    /** How it stands to that note; meaningless without `reply_to`. */
    relation: cardNoteRelationSchema.nullable(),
  }),
]);
export type CardEvent = z.infer<typeof cardEventSchema>;
