import type {
  Card,
  CardBranch,
  CardNoteRelation,
  CardRef,
  CardRelease,
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

/**
 * The branch rule's inputs for work entering active: the branch it runs on,
 * or why it has none. Whether the card already holds an open branch is the
 * store's to know.
 */
export interface EnterActiveParams {
  branch?: CardBranch;
  noBranch?: string;
}

export interface CreateCardParams extends CardAuthorship, EnterActiveParams {
  scope: string;
  title: string;
  body?: string;
  state?: CardState;
}

export interface PromoteLoopParams extends CardAuthorship, EnterActiveParams {
  loopId: string;
  title: string;
  body?: string;
  state?: CardState;
}

export interface MoveCardParams extends CardAuthorship, EnterActiveParams {
  cardId: string;
  to: CardState;
  reason: string;
  /** Leaving active with an open branch that has not landed: why. */
  notLanded?: string;
}

/** A branch that landed as a squash commit on its target. */
export interface LandCardParams extends CardAuthorship {
  cardId: string;
  branch: CardBranch;
  squashSha: string;
  target: string;
  reason: string;
  /** Where the card goes; the store defaults to waiting. */
  to?: CardState;
  /** Why ANOTHER branch still open on the card has not landed. */
  notLanded?: string;
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
  /** Continue the feed past this memory (the previous page's cursor). */
  feedBefore?: string;
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
  /** What the mover declared in place of the branch rule. */
  branch_note: string | null;
  /** For a landing: the commit and the branch it landed on. */
  squash_sha: string | null;
  target_branch: string | null;
  created_at: string;
}

/** One landing of a branch: the squash commit, where it went, and when. */
export interface CardBranchLanding {
  squash_sha: string;
  target: string | null;
  landed_at: string;
}

/**
 * A branch as a reader sees it on its card. `squash_sha` is its latest
 * landing; `landings` is every landing, oldest first — a branch lands again
 * when a fix is made in the branch that brought the bug.
 */
export interface CardBranchView {
  repo: string;
  branch: string;
  state: 'open' | 'landed';
  squash_sha: string | null;
  target: string | null;
  landed_at: string | null;
  attached_at: string;
  landings: CardBranchLanding[];
}

/**
 * One memory of a card's feed: born in a conversation bound to the card, in
 * its scope, still live. Derived when read — the card stores none of it.
 */
export interface CardFeedItemView {
  memory_id: string;
  kind: string;
  preview: string;
  thread: string;
  created_at: string;
}

export interface CardReadView {
  card: Card;
  refs: CardRefView[];
  /** Where the card's work ran, and where it landed. */
  branches: CardBranchView[];
  /** The production states this card was carried by, newest first. */
  releases: CardRelease[];
  events: CardEventView[];
  has_more: boolean;
  next_after_seq: number;
  /** Newest first; empty when no conversation is bound. */
  feed: CardFeedItemView[];
  feed_has_more: boolean;
  feed_next_before: string | null;
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
  /** The version this card was last carried by, or null if none yet. */
  released_in: string | null;
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
  land(params: LandCardParams): Promise<Result<CardWrite, CardFailure>>;
}
