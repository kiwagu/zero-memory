import { z } from 'zod';

import { entityIdSchemas } from './entity-prefixes.js';
import { entityIdSchema } from './graph.schema.js';
import {
  memoryIdSchema,
  memoryKindSchema,
  memoryScopeSchema,
} from './memory.schema.js';
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

/**
 * One event of a card's append-only stream, as a reader receives it.
 *
 * Flat, with a column per fact and nulls where a type does not use one —
 * because that is what the store holds and returns. The per-type shape (a
 * `moved` row always has a reason, a `noted` row always has text) is a check
 * constraint on the table rather than a second model here: one enforcing
 * copy, in the place a direct database call also has to pass.
 */
export const cardEventSchema = z.object({
  id: cardEventIdSchema,
  seq: z.number().int().positive(),
  type: cardEventTypeSchema,
  actor_id: userIdSchema,
  agent_label: z.string().nullable(),
  thread: z.string().nullable(),
  from_state: cardStateSchema.nullable(),
  to_state: cardStateSchema.nullable(),
  reason: z.string().nullable(),
  revision: z.number().int().nullable(),
  text: z.string().nullable(),
  reply_to: z.string().nullable(),
  relation: cardNoteRelationSchema.nullable(),
  ref_kind: z.enum(CARD_REF_KINDS).nullable(),
  ref_target: z.string().nullable(),
  created_at: z.string(),
});
export type CardEvent = z.infer<typeof cardEventSchema>;

/**
 * An attachment as a reader receives it.
 *
 * `preview` is present only when the reader may read the target: the store
 * resolves it under that reader's own fences, so a memory in a scope they do
 * not belong to arrives as an id with `available: false`. The card stays
 * legible without leaking a line of what is behind the reference.
 */
export const cardRefViewSchema = z.object({
  kind: z.enum(CARD_REF_KINDS),
  target: z.string(),
  attached_at: z.string(),
  available: z.boolean(),
  preview: z.string().nullable(),
});
export type CardRefView = z.infer<typeof cardRefViewSchema>;

/**
 * One memory in a card's feed: born in a conversation bound to the card, in
 * the card's own scope, still live. The feed is derived when it is read, so
 * this is a view of the memory — never a copy of it.
 */
export const cardFeedItemSchema = z.object({
  memory_id: memoryIdSchema,
  kind: memoryKindSchema,
  preview: z.string(),
  /** The bound conversation it was born in. */
  thread: z.string(),
  created_at: z.string(),
});
export type CardFeedItem = z.infer<typeof cardFeedItemSchema>;

/** One row of the board listing. */
export const boardCardSchema = z.object({
  id: cardIdSchema,
  scope: memoryScopeSchema,
  number: z.number().int().positive(),
  title: z.string(),
  state: cardStateSchema,
  updated_at: z.string(),
  archived_at: z.string().nullable(),
  /** How many artifacts the card points at. */
  refs: z.number().int().nonnegative(),
  /** What last happened to it, so a board reads as activity, not as a list. */
  last_event: z
    .object({
      type: cardEventTypeSchema,
      reason: z.string().nullable(),
      created_at: z.string(),
    })
    .nullable(),
});
export type BoardCard = z.infer<typeof boardCardSchema>;

/** Who is writing, and in which conversation. Every write tool takes these. */
const authorshipFields = {
  thread: z
    .string()
    .optional()
    .describe(
      'The conversation this is written in, recorded with the entry so a ' +
        'reader can see where it came from. It does not bind the ' +
        'conversation to the card: for that, attach it with `card_log` ' +
        '(`ref_kind: thread`).'
    ),
  agent_label: cardAgentLabelSchema
    .optional()
    .describe(
      'The name you go by on this board. Metadata for whoever reads it — ' +
        'your rights come from your credentials, never from this.'
    ),
  idempotency_key: cardIdempotencyKeySchema
    .optional()
    .describe(
      'Repeat it to make a retry after a timeout land once. The same key ' +
        'returns the first result instead of writing a second row.'
    ),
};

/** `board` — the read side. */
export const boardInputSchema = z.object({
  action: z
    .enum(['list', 'get', 'resolve'])
    .default('list')
    .describe(
      'list: the cards of a scope. get: one card with its attachments, a ' +
        'page of its history and a page of its feed — the memories born in ' +
        'the conversations bound to it. resolve: turn a project-local number ' +
        'into a card.'
    ),
  scope: z
    .string()
    .optional()
    .describe('Which project board. Required for list and resolve.'),
  state: cardStateSchema.optional().describe('Show only this column.'),
  query: z
    .string()
    .optional()
    .describe(
      'Match card titles. Returns every candidate — it never picks one for you.'
    ),
  include_archived: z.boolean().optional(),
  card_id: cardIdSchema.optional().describe('Required for get.'),
  number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The project-local number for resolve, e.g. 42 for `#42`.'),
  after_seq: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Read only what happened after this position in the history.'),
  feed_before: memoryIdSchema
    .optional()
    .describe(
      'For get: continue the feed past this memory — the `feed_next_before` ' +
        'a previous page returned.'
    ),
  limit: z.number().int().positive().max(200).optional(),
});
export type BoardInput = z.infer<typeof boardInputSchema>;

export const boardOutputSchema = z.object({
  cards: z.array(boardCardSchema).default([]),
  /** Live count per state, so a summary needs no second call. */
  totals: z.record(z.string(), z.number()).default({}),
  card: cardSchema.nullable().default(null),
  refs: z.array(cardRefViewSchema).default([]),
  events: z.array(cardEventSchema).default([]),
  has_more: z.boolean().default(false),
  next_after_seq: z.number().default(0),
  /**
   * For get: the memories born in the conversations bound to the card,
   * newest first. Nothing about them is stored on the card — they belong to
   * it because of where they were written.
   */
  feed: z.array(cardFeedItemSchema).default([]),
  feed_has_more: z.boolean().default(false),
  feed_next_before: z.string().nullable().default(null),
});
export type BoardOutput = z.infer<typeof boardOutputSchema>;

/** `card` — opening and steering one piece of work. */
export const cardInputSchema = z.object({
  action: z
    .enum(['create', 'promote_loop', 'edit', 'move', 'archive'])
    .describe(
      'create: open a card. promote_loop: turn an open loop into one, ' +
        'recording where it came from and leaving the loop itself alone. ' +
        'edit: rewrite its text. move: declare where the work stands, with ' +
        'the reason why. archive: take it off the board for good.'
    ),
  card_id: cardIdSchema
    .optional()
    .describe('Required for edit, move and archive.'),
  scope: z.string().optional().describe('Which project board. For create.'),
  loop_id: memoryIdSchema
    .optional()
    .describe('The task or open-question memory to promote.'),
  title: cardTitleSchema.optional(),
  body: cardBodySchema
    .optional()
    .describe(
      'The document: the goal, its boundaries, what "done" means. Markdown.'
    ),
  state: cardStateSchema
    .optional()
    .describe('Where a new card starts. Defaults to idea.'),
  to: cardStateSchema.optional().describe('Where the card is moving.'),
  reason: cardReasonSchema
    .optional()
    .describe(
      'Why the state changed — required for move and archive. This is what ' +
        'the next reader has instead of guessing; there is no way to move a ' +
        'card without it.'
    ),
  expected_revision: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Refuse the edit unless the card is still at this revision, so two ' +
        'writers cannot overwrite each other silently.'
    ),
  ...authorshipFields,
});
export type CardInput = z.infer<typeof cardInputSchema>;

export const cardOutputSchema = z.object({
  card: cardSchema,
  /** False when the call was a no-op (nothing to change, already attached). */
  changed: z.boolean().default(true),
  /** True when an idempotency key replayed an earlier call's result. */
  replayed: z.boolean().default(false),
});
export type CardOutput = z.infer<typeof cardOutputSchema>;

/** `card_log` — the card's stream: notes and attachments. */
export const cardLogInputSchema = z.object({
  action: z
    .enum(['note', 'attach', 'detach'])
    .describe(
      'note: add a statement of your own. attach / detach: point the card at ' +
        'an artifact, or stop pointing at it.'
    ),
  card_id: cardIdSchema,
  text: cardNoteTextSchema
    .optional()
    .describe(
      'What you want on the record. A note is your statement, not a verdict: ' +
        'writing that the work is done does not move the card — a move does.'
    ),
  reply_to: cardEventIdSchema
    .optional()
    .describe('The note you are answering.'),
  relation: cardNoteRelationSchema
    .optional()
    .describe('How your note stands to the one it answers.'),
  ref_kind: z
    .enum(CARD_REF_KINDS)
    .optional()
    .describe(
      'What kind of artifact. An open loop is a memory, so attach it as one. ' +
        'Attaching a `thread` binds that conversation: what it remembers in ' +
        "the card's scope then appears in the card's feed on its own."
    ),
  ref_target: z
    .string()
    .max(CARD_LIMITS.url)
    .optional()
    .describe('Its id, or the url for an external one.'),
  ...authorshipFields,
});
export type CardLogInput = z.infer<typeof cardLogInputSchema>;

export const cardLogOutputSchema = z.object({
  /** The note's id, so a later note can answer it. Null for attachments. */
  event_id: z.string().nullable().default(null),
  changed: z.boolean().default(true),
  replayed: z.boolean().default(false),
});
export type CardLogOutput = z.infer<typeof cardLogOutputSchema>;
