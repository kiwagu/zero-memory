import type {
  Card,
  CardNoteRelation,
  CardRef,
  CardState,
} from '@workspace/contracts';
import type { Result } from 'oxide.ts';

import type { CardFailure } from './card.errors.js';

/** Who wrote this, in which conversation — stamped onto every event. */
export interface CardAuthorship {
  thread?: string | null;
  agentLabel?: string | null;
  /** Makes a retry after a network timeout land once. */
  idempotencyKey?: string | null;
}

export interface CreateCardParams extends CardAuthorship {
  scope: string;
  title: string;
  body?: string;
  state?: CardState;
}

export interface PromoteLoopParams extends CardAuthorship {
  loopId: string;
  title: string;
  body?: string;
  state?: CardState;
}

export interface MoveCardParams extends CardAuthorship {
  cardId: string;
  to: CardState;
  reason: string;
}

export interface EditCardParams extends CardAuthorship {
  cardId: string;
  title?: string;
  body?: string;
  expectedRevision?: number;
}

export interface ArchiveCardParams extends CardAuthorship {
  cardId: string;
  reason: string;
}

export interface AttachRefParams extends CardAuthorship {
  cardId: string;
  ref: CardRef;
}

export interface NoteCardParams extends CardAuthorship {
  cardId: string;
  text: string;
  replyTo?: string | null;
  relation?: CardNoteRelation | null;
}

export interface ReadCardParams {
  cardId: string;
  afterSeq?: number;
  limit?: number;
}

export interface ListBoardParams {
  scope?: string | null;
  state?: CardState | null;
  query?: string | null;
  includeArchived?: boolean;
  limit?: number;
}

/** A card plus whether the call changed anything or replayed an earlier one. */
export interface CardWrite {
  card: Card;
  changed: boolean;
  replayed: boolean;
}

/** One attachment as a reader sees it — with a preview only if they may. */
export interface CardRefView {
  kind: CardRef['kind'];
  target: string;
  attached_at: string;
  /** False when the target is gone or the reader has no right to it. */
  available: boolean;
  preview: string | null;
}

export interface CardEventView {
  id: string;
  seq: number;
  type: string;
  actor_id: string;
  agent_label: string | null;
  thread: string | null;
  from_state: CardState | null;
  to_state: CardState | null;
  reason: string | null;
  revision: number | null;
  text: string | null;
  reply_to: string | null;
  relation: CardNoteRelation | null;
  ref_kind: CardRef['kind'] | null;
  ref_target: string | null;
  created_at: string;
}

export interface CardReadView {
  card: Card;
  refs: CardRefView[];
  events: CardEventView[];
  has_more: boolean;
  next_after_seq: number;
}

export interface BoardCardView {
  id: string;
  scope: string;
  number: number;
  title: string;
  state: CardState;
  updated_at: string;
  archived_at: string | null;
  refs: number;
  last_event: {
    type: string;
    reason: string | null;
    created_at: string;
  } | null;
}

export interface BoardView {
  cards: BoardCardView[];
  totals: Partial<Record<CardState, number>>;
}

/**
 * Port to the card store.
 *
 * Every method maps to one atomic store command. That is deliberate rather
 * than incidental: allocating a card's project-local number and its next
 * stream position are read-modify-write races, and a retry after a timeout
 * must land once — neither can be decided by an application that may be one of
 * several talking to the same card.
 */
export interface ICardRepository {
  create(params: CreateCardParams): Promise<Result<CardWrite, CardFailure>>;
  promoteLoop(
    params: PromoteLoopParams
  ): Promise<Result<CardWrite, CardFailure>>;
  move(params: MoveCardParams): Promise<Result<CardWrite, CardFailure>>;
  edit(params: EditCardParams): Promise<Result<CardWrite, CardFailure>>;
  archive(params: ArchiveCardParams): Promise<Result<CardWrite, CardFailure>>;
  attach(params: AttachRefParams): Promise<Result<CardWrite, CardFailure>>;
  detach(params: AttachRefParams): Promise<Result<CardWrite, CardFailure>>;
  note(
    params: NoteCardParams
  ): Promise<
    Result<{ eventId: string | null; replayed: boolean }, CardFailure>
  >;
  read(params: ReadCardParams): Promise<Result<CardReadView, CardFailure>>;
  list(params: ListBoardParams): Promise<Result<BoardView, CardFailure>>;
  resolve(scope: string, number: number): Promise<Result<Card, CardFailure>>;
}
