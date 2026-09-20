import {
  cardBodySchema,
  cardNoteTextSchema,
  cardReasonSchema,
  cardStateSchema,
  cardTitleSchema,
  memoryScopeSchema,
  newCardId,
  type CardEventId,
  type CardId,
  type CardNoteRelation,
  type CardRef,
  type CardState,
  type MemoryId,
} from '@workspace/contracts';
import { Err, Ok, type Result } from 'oxide.ts';

import { cardRefKey, sameCardRef } from './card-ref.vo.js';
import type { CardEventDraft } from './card.events.js';

export interface CardProps {
  scope: string;
  number: number;
  title: string;
  body: string;
  state: CardState;
  revision: number;
  originLoopId: MemoryId | null;
  refs: CardRef[];
  archivedAt: Date | null;
}

export interface CreateCardInput {
  id?: CardId;
  scope: string;
  number: number;
  title: string;
  body?: string;
  state?: CardState;
  /** Set when the card was promoted out of an open loop. */
  originLoopId?: MemoryId | null;
}

export interface EditCardInput {
  title?: string;
  body?: string;
  /** Refuse the edit unless the card is still at this revision. */
  expectedRevision?: number;
}

export interface NoteCardInput {
  text: string;
  replyTo?: CardEventId | null;
  relation?: CardNoteRelation | null;
}

/** Whether the call actually changed the card — a no-op writes no event. */
export interface CardChange {
  changed: boolean;
}

const ARCHIVED = 'This card is archived and no longer accepts changes.';

/**
 * The container of one piece of work: what is being done, where it stands,
 * and the artifacts it is made of.
 *
 * Two invariants carry the whole design and are enforced here rather than
 * trusted to callers:
 *
 * 1. EVERY MOVE CARRIES A REASON. A state change without a stated
 *    justification is the unexplained transition the board exists to avoid,
 *    which is why no interface offers a gesture that could produce one.
 * 2. STATE GATES NOTHING. Any state may follow any other — a finished card
 *    reopens, an idea is parked — and no state blocks attaching, noting or
 *    editing. The card reports work; it never schedules it.
 *
 * Archiving is the one terminal act: it takes the card off the board and
 * freezes it. Reversible shelving is the `parked` state, which stays on the
 * board and moves back like any other.
 */
export class Card {
  readonly id: CardId;

  #props: CardProps;

  #events: CardEventDraft[] = [];

  private constructor(id: CardId, props: CardProps) {
    this.id = id;
    this.#props = props;
  }

  static create(input: CreateCardInput): Result<Card, string> {
    const scope = memoryScopeSchema.safeParse(input.scope);
    if (!scope.success) {
      return Err('A card needs the scope it belongs to.');
    }
    if (!Number.isInteger(input.number) || input.number < 1) {
      return Err('A card needs a positive project-local number.');
    }
    const title = cardTitleSchema.safeParse(input.title);
    if (!title.success) {
      return Err('A card title must not be empty.');
    }
    const body = cardBodySchema.safeParse(input.body ?? '');
    if (!body.success) {
      return Err('The card body is longer than the limit.');
    }
    const state = cardStateSchema.safeParse(input.state ?? 'idea');
    if (!state.success) {
      return Err(
        `Invalid card state: expected one of ${cardStateSchema.options.join(', ')}.`
      );
    }

    const originLoopId = input.originLoopId ?? null;
    const card = new Card(input.id ?? newCardId(), {
      scope: scope.data,
      number: input.number,
      title: title.data,
      body: body.data,
      state: state.data,
      revision: 1,
      originLoopId,
      refs: [],
      archivedAt: null,
    });
    card.#events.push({
      type: 'created',
      toState: state.data,
      originLoopId,
    });
    return Ok(card);
  }

  /** Rebuild a stored card; raises no events. */
  static restore(id: CardId, props: CardProps): Card {
    return new Card(id, { ...props, refs: [...props.refs] });
  }

  get scope(): string {
    return this.#props.scope;
  }

  get number(): number {
    return this.#props.number;
  }

  get title(): string {
    return this.#props.title;
  }

  get body(): string {
    return this.#props.body;
  }

  get state(): CardState {
    return this.#props.state;
  }

  get revision(): number {
    return this.#props.revision;
  }

  get originLoopId(): MemoryId | null {
    return this.#props.originLoopId;
  }

  get refs(): readonly CardRef[] {
    return this.#props.refs;
  }

  get isArchived(): boolean {
    return this.#props.archivedAt !== null;
  }

  /** Drafts raised so far, in the order they happened. */
  get events(): readonly CardEventDraft[] {
    return this.#events;
  }

  clearEvents(): void {
    this.#events = [];
  }

  /**
   * Rewrite the card's text.
   *
   * An edit that changes nothing is not an error and writes no event: a
   * stream full of empty edits would bury the moves that matter.
   */
  edit(input: EditCardInput): Result<CardChange, string> {
    if (this.isArchived) {
      return Err(ARCHIVED);
    }
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== this.#props.revision
    ) {
      return Err(
        `This card is at revision ${this.#props.revision}, not ` +
          `${input.expectedRevision}: read it again before editing.`
      );
    }

    let title = this.#props.title;
    if (input.title !== undefined) {
      const parsed = cardTitleSchema.safeParse(input.title);
      if (!parsed.success) {
        return Err('A card title must not be empty.');
      }
      title = parsed.data;
    }

    let body = this.#props.body;
    if (input.body !== undefined) {
      const parsed = cardBodySchema.safeParse(input.body);
      if (!parsed.success) {
        return Err('The card body is longer than the limit.');
      }
      body = parsed.data;
    }

    if (title === this.#props.title && body === this.#props.body) {
      return Ok({ changed: false });
    }

    this.#props = {
      ...this.#props,
      title,
      body,
      revision: this.#props.revision + 1,
    };
    this.#events.push({ type: 'edited', revision: this.#props.revision });
    return Ok({ changed: true });
  }

  /**
   * Declare where the work now stands.
   *
   * The reason is the point of the call, not decoration: it is what a reader
   * (or the next agent) has instead of having to reconstruct why the column
   * changed.
   */
  moveTo(state: string, reason: string): Result<CardChange, string> {
    if (this.isArchived) {
      return Err(ARCHIVED);
    }
    const parsedState = cardStateSchema.safeParse(state);
    if (!parsedState.success) {
      return Err(
        `Invalid card state: expected one of ${cardStateSchema.options.join(', ')}.`
      );
    }
    const parsedReason = cardReasonSchema.safeParse(reason);
    if (!parsedReason.success) {
      return Err('A move must carry a reason saying why the state changed.');
    }
    if (parsedState.data === this.#props.state) {
      return Err(
        `This card is already ${this.#props.state}; a move must change it.`
      );
    }

    const fromState = this.#props.state;
    this.#props = { ...this.#props, state: parsedState.data };
    this.#events.push({
      type: 'moved',
      fromState,
      toState: parsedState.data,
      reason: parsedReason.data,
    });
    return Ok({ changed: true });
  }

  /** Take the card off the board. Terminal: an archived card is read-only. */
  archive(reason: string): Result<CardChange, string> {
    if (this.isArchived) {
      return Err(ARCHIVED);
    }
    const parsedReason = cardReasonSchema.safeParse(reason);
    if (!parsedReason.success) {
      return Err('Archiving must carry a reason.');
    }
    this.#props = { ...this.#props, archivedAt: new Date() };
    this.#events.push({ type: 'archived', reason: parsedReason.data });
    return Ok({ changed: true });
  }

  /**
   * Point the card at an artifact.
   *
   * Attaching the same target twice is a no-op rather than an error, so a
   * retry — or two agents noticing the same memory — leaves one attachment.
   */
  attach(ref: CardRef): Result<CardChange, string> {
    if (this.isArchived) {
      return Err(ARCHIVED);
    }
    if (ref.kind === 'card' && ref.id === this.id) {
      return Err('A card cannot reference itself.');
    }
    if (this.#props.refs.some((existing) => sameCardRef(existing, ref))) {
      return Ok({ changed: false });
    }
    this.#props = { ...this.#props, refs: [...this.#props.refs, ref] };
    this.#events.push({ type: 'attached', ref });
    return Ok({ changed: true });
  }

  /** Remove a reference. The attachment's history stays in the stream. */
  detach(ref: CardRef): Result<CardChange, string> {
    if (this.isArchived) {
      return Err(ARCHIVED);
    }
    const remaining = this.#props.refs.filter(
      (existing) => !sameCardRef(existing, ref)
    );
    if (remaining.length === this.#props.refs.length) {
      return Err(`Nothing attached under ${cardRefKey(ref)}.`);
    }
    this.#props = { ...this.#props, refs: remaining };
    this.#events.push({ type: 'detached', ref });
    return Ok({ changed: true });
  }

  /**
   * Add an author's statement to the stream.
   *
   * A note never changes the card: text saying "this is finished" is a claim
   * its author makes, and the card moves only when someone moves it with a
   * reason.
   */
  note(input: NoteCardInput): Result<CardChange, string> {
    if (this.isArchived) {
      return Err(ARCHIVED);
    }
    const text = cardNoteTextSchema.safeParse(input.text);
    if (!text.success) {
      return Err('A note must not be empty.');
    }
    const replyTo = input.replyTo ?? null;
    const relation = input.relation ?? null;
    if (relation !== null && replyTo === null) {
      return Err(
        `A "${relation}" relation needs the note it answers: pass replyTo.`
      );
    }
    this.#events.push({ type: 'noted', text: text.data, replyTo, relation });
    return Ok({ changed: true });
  }
}
