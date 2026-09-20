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
  created_at: z.string(),
});
export type CardEvent = z.infer<typeof cardEventSchema>;

export const cardViewSchema = z.object({
  card: cardSchema,
  refs: z.array(cardRefSchema).default([]),
  events: z.array(cardEventSchema).default([]),
  has_more: z.boolean().default(false),
  next_after_seq: z.number().default(0),
});
export type CardView = z.infer<typeof cardViewSchema>;

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
    default:
      return type;
  }
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
