import { z } from 'zod';

import { entityIdSchemas } from './entity-prefixes.js';
import {
  memoryIdSchema,
  memoryKindSchema,
  memoryLinkTypeSchema,
  memoryScopeSchema,
} from './memory.schema.js';

/** An entity id: a branded `ent_` entity id. */
export const entityIdSchema = entityIdSchemas.entity.schema;
export type EntityId = z.infer<typeof entityIdSchema>;

/** Mint a fresh entity id (trusted construction). */
export const newEntityId = (): EntityId => entityIdSchemas.entity.create();

/** Kinds of knowledge-graph entities (controlled vocabulary, DESIGN §6.4). */
export const entityTypeSchema = z.enum([
  'person',
  'project',
  'repo',
  'package',
  'service',
  'tool',
  'library',
  'concept',
]);
export type EntityType = z.infer<typeof entityTypeSchema>;

/** Kinds of entity->entity edges (controlled vocabulary). */
export const edgeTypeSchema = z.enum([
  'uses',
  'works_on',
  'prefers',
  'part_of',
  'depends_on',
  'decided',
  'replaces',
  'relates_to',
]);
export type EdgeType = z.infer<typeof edgeTypeSchema>;

/** An entity mention attached to a `remember` call. */
export const entityMentionSchema = z.object({
  name: z.string().min(1),
  type: entityTypeSchema.optional(),
});
export type EntityMention = z.infer<typeof entityMentionSchema>;

/** One entity row as listed/searched by the `entities` tool. */
export const entityHitSchema = z.object({
  id: entityIdSchema,
  name: z.string(),
  type: entityTypeSchema,
  scope: memoryScopeSchema,
  created_at: z.string(),
});
export type EntityHit = z.infer<typeof entityHitSchema>;

/** Entity as it appears inside a context briefing or an enriched recall hit. */
export const contextEntitySchema = z.object({
  id: entityIdSchema,
  name: z.string(),
  type: entityTypeSchema,
  /**
   * Present when the briefing collapsed same-named duplicate entities into
   * this row: the distinct types seen across the duplicates. Additive — old
   * packs (and non-briefing contexts) omit it.
   */
  types: z.array(entityTypeSchema).optional(),
  /** How many duplicate entity rows this collapsed row represents. */
  count: z.number().int().positive().optional(),
});
export type ContextEntity = z.infer<typeof contextEntitySchema>;

/** Edge as it appears inside a context briefing (endpoints are names). */
export const contextEdgeSchema = z.object({
  src: z.string(),
  dst: z.string(),
  type: edgeTypeSchema,
  weight: z.number().optional(),
});
export type ContextEdge = z.infer<typeof contextEdgeSchema>;

/** Memory as it appears inside a context briefing. */
export const contextMemorySchema = z.object({
  id: memoryIdSchema,
  content: z.string(),
  kind: memoryKindSchema,
  scope: memoryScopeSchema,
  created_at: z.string(),
  score: z.number().optional(),
  /**
   * True when the briefing capped an over-long content to its first N
   * characters (the full text stays one `recall` away by id). Additive —
   * absent means the content is complete.
   */
  truncated: z.boolean().optional(),
});
export type ContextMemory = z.infer<typeof contextMemorySchema>;

/**
 * A memory reachable from a hit through a TYPED LINK, delivered as a stub.
 *
 * Atomic facts are stored one per memory; the relations that give them meaning
 * (what superseded this, what it contradicts, what it came from) are edges,
 * and a flat hit list drops them. A stub restores the connection for almost no
 * tokens: it says WHICH memory, HOW it relates, and to WHICH hit — the body
 * stays one `recall` (or `zm://memory/{id}`) away, so the caller spends
 * context only on the relations it actually wants.
 */
export const relatedMemorySchema = z.object({
  id: memoryIdSchema,
  /** The hit this memory is related to. */
  of: memoryIdSchema,
  /** How it relates — direction is normalized to "of -> id". */
  relation: memoryLinkTypeSchema,
  kind: memoryKindSchema,
  /** The opening of the content, whitespace-collapsed. Never the whole body. */
  preview: z.string(),
});
export type RelatedMemory = z.infer<typeof relatedMemorySchema>;

/**
 * Standing rule as it appears inside a context briefing: the promoted rule's
 * imperative text plus whether the owner PINNED it. A pinned rule leads the
 * array — it is exempt from the delivery cap and TTL, so ranking can never
 * drop it — and carries the flag so the reader can tell a guaranteed rule
 * from one that merely fit.
 */
export const contextRuleSchema = z.object({
  text: z.string(),
  pinned: z.boolean(),
});
export type ContextRule = z.infer<typeof contextRuleSchema>;
