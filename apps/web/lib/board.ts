import { z } from 'zod';

import type { WebTranslator } from '@workspace/i18n-catalogs/web';

/**
 * Result shapes of the board RPCs, web-only.
 *
 * They are declared here rather than imported from the contracts package for
 * the same reason the other dashboard readers declare theirs: the Next bundler
 * cannot resolve that package's NodeNext internal imports. The store is the
 * authority either way — this file only has to describe what it sends.
 */

/**
 * A card's one label: the dashboard, a briefing and the squash trailer all
 * call it ZM-N, so a search for one finds the others. Declared here rather
 * than imported for the same bundler reason as the schemas below.
 */
export const cardLabel = (number: number): string => `ZM-${number}`;

export const CARD_STATES = [
  'idea',
  'active',
  'waiting',
  'done',
  'parked',
] as const;
export type CardState = (typeof CARD_STATES)[number];

const cardStateSchema = z.enum(CARD_STATES);

/** One row of the board listing. */
export const boardCardSchema = z.object({
  id: z.string(),
  scope: z.string(),
  number: z.number(),
  title: z.string(),
  state: cardStateSchema,
  updated_at: z.string(),
  archived_at: z.string().nullable(),
  refs: z.number(),
  last_event: z
    .object({
      type: z.string(),
      reason: z.string().nullable(),
      created_at: z.string(),
    })
    .nullable(),
  /**
   * Why the card sits in this column — the reason of the move that put it
   * there, which survives every later note and attachment. A tile that showed
   * only the latest touch would hide exactly the thing the board exists for.
   */
  state_reason: z.string().nullable().default(null),
});
export type BoardCard = z.infer<typeof boardCardSchema>;

/** One board the caller can see: its scope, its size and when it last moved. */
export const boardScopeSchema = z.object({
  scope: z.string(),
  cards: z.number(),
  last_activity_at: z.string(),
});
export type BoardScope = z.infer<typeof boardScopeSchema>;

export const boardScopesSchema = z.array(boardScopeSchema);

/**
 * Which board to show, given what the address says and what exists.
 *
 * No parameter means "the one that moved last" — a reader who arrives with no
 * opinion gets the work in motion rather than the alphabetical first. The
 * sentinel `all` is the deliberate choice to see every board at once, and it
 * IS in the URL because it is not the default.
 *
 * A parameter naming a board with nothing on it is HONOURED, not corrected.
 * An empty board is a true answer — the work there is done or has not started
 * — and quietly showing a different board instead would tell the reader the
 * address they are looking at holds something it does not.
 */
export const ALL_BOARDS = 'all';

export function resolveBoardScope(
  requested: string | undefined,
  boards: BoardScope[]
): { selected: string | null; value: string } {
  if (requested === ALL_BOARDS) {
    return { selected: null, value: ALL_BOARDS };
  }
  if (requested) {
    return { selected: requested, value: requested };
  }
  // The placeholder row: the default, and therefore absent from the URL.
  // With no boards at all there is nothing to select and nothing to show.
  return { selected: boards[0]?.scope ?? null, value: '' };
}

export const boardListSchema = z.object({
  cards: z.array(boardCardSchema).default([]),
  totals: z.record(z.string(), z.number()).default({}),
});
export type BoardList = z.infer<typeof boardListSchema>;

export const cardSchema = z.object({
  id: z.string(),
  scope: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: cardStateSchema,
  revision: z.number(),
  origin_loop_id: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  archived_at: z.string().nullable(),
});
export type Card = z.infer<typeof cardSchema>;

export const cardRefSchema = z.object({
  kind: z.string(),
  target: z.string(),
  attached_at: z.string(),
  /** False when the target is gone, or when this reader may not open it. */
  available: z.boolean(),
  preview: z.string().nullable(),
});
export type CardRef = z.infer<typeof cardRefSchema>;

export const cardEventSchema = z.object({
  id: z.string(),
  seq: z.number(),
  type: z.string(),
  actor_id: z.string(),
  agent_label: z.string().nullable(),
  thread: z.string().nullable(),
  from_state: z.string().nullable(),
  to_state: z.string().nullable(),
  reason: z.string().nullable(),
  revision: z.number().nullable(),
  text: z.string().nullable(),
  reply_to: z.string().nullable(),
  relation: z.string().nullable(),
  ref_kind: z.string().nullable(),
  ref_target: z.string().nullable(),
  branch_note: z.string().nullable().default(null),
  squash_sha: z.string().nullable().default(null),
  target_branch: z.string().nullable().default(null),
  created_at: z.string(),
});
export type CardEvent = z.infer<typeof cardEventSchema>;

/** A git branch the card's work ran on, open or landed. */
export const cardBranchSchema = z.object({
  repo: z.string(),
  branch: z.string(),
  state: z.enum(['open', 'landed']),
  squash_sha: z.string().nullable(),
  target: z.string().nullable(),
  landed_at: z.string().nullable(),
  attached_at: z.string(),
});
export type CardBranch = z.infer<typeof cardBranchSchema>;

export const cardViewSchema = z.object({
  card: cardSchema,
  refs: z.array(cardRefSchema).default([]),
  branches: z.array(cardBranchSchema).default([]),
  events: z.array(cardEventSchema).default([]),
  has_more: z.boolean().default(false),
  next_after_seq: z.number().default(0),
});
export type CardView = z.infer<typeof cardViewSchema>;

/**
 * A page of the card's feed: memories born in the conversations bound to it,
 * newest first. Derived on read, so nothing here is stored on the card.
 */
export const cardFeedSchema = z.object({
  feed: z
    .array(
      z.object({
        memory_id: z.string(),
        kind: z.string(),
        preview: z.string(),
        thread: z.string(),
        created_at: z.string(),
      })
    )
    .default([]),
  has_more: z.boolean().default(false),
  next_before: z.string().nullable().default(null),
});
export type CardFeed = z.infer<typeof cardFeedSchema>;

/** Literal keys only (lint-enforced): dynamic `t(\`board.${…}\`)` is banned. */
export function cardStateLabel(state: string, t: WebTranslator): string {
  switch (state) {
    case 'idea':
      return t('board.state.idea');
    case 'active':
      return t('board.state.active');
    case 'waiting':
      return t('board.state.waiting');
    case 'done':
      return t('board.state.done');
    case 'parked':
      return t('board.state.parked');
    default:
      return state;
  }
}

/** What happened, in words. The reason travels next to it, never inside it. */
export function cardEventLabel(type: string, t: WebTranslator): string {
  switch (type) {
    case 'created':
      return t('board.event.created');
    case 'edited':
      return t('board.event.edited');
    case 'moved':
      return t('board.event.moved');
    case 'archived':
      return t('board.event.archived');
    case 'attached':
      return t('board.event.attached');
    case 'detached':
      return t('board.event.detached');
    case 'noted':
      return t('board.event.noted');
    case 'landed':
      return t('board.event.landed');
    default:
      return type;
  }
}

/** Where a branch stands, in words: open, or where it landed. */
export function cardBranchStateLabel(
  branch: CardBranch,
  t: WebTranslator
): string {
  if (branch.state === 'landed' && branch.squash_sha && branch.target) {
    return t('board.branch.landed', {
      sha: branch.squash_sha.slice(0, 7),
      target: branch.target,
    });
  }
  return t('board.branch.open');
}

export function cardRelationLabel(relation: string, t: WebTranslator): string {
  switch (relation) {
    case 'supports':
      return t('board.relation.supports');
    case 'disputes':
      return t('board.relation.disputes');
    case 'corrects':
      return t('board.relation.corrects');
    default:
      return relation;
  }
}

/**
 * Where a reference points, when the reader may follow it.
 *
 * A memory and another card have pages of their own; an entity is reached
 * through the entity search, and a thread has no page at all, so both stay
 * plain text rather than pretending to be links. An unavailable target is
 * never linked — the board must not offer a door that opens on a refusal.
 */
export function cardRefHref(ref: CardRef): string | undefined {
  if (!ref.available) {
    return undefined;
  }
  if (ref.kind === 'memory') {
    return `/memory/${ref.target}`;
  }
  if (ref.kind === 'card') {
    return `/board/${ref.target}`;
  }
  if (ref.kind === 'url') {
    return ref.target;
  }
  return undefined;
}

/** The colour a state wears, kept in one place so every surface agrees. */
export function cardStateVariant(
  state: string
): 'secondary' | 'blue' | 'amber' | 'green' | 'outline' {
  switch (state) {
    case 'active':
      return 'blue';
    case 'waiting':
      return 'amber';
    case 'done':
      return 'green';
    case 'parked':
      return 'outline';
    default:
      return 'secondary';
  }
}
