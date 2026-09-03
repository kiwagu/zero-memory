import {
  entityIdSchema,
  type ContextEntity,
  type EntityHit,
  type EntityType,
} from '@workspace/contracts';
import type { Option, Result } from 'oxide.ts';
import { z } from 'zod';

import type { Entity } from './entity.do.js';
import type { Scope } from './scope.vo.js';

/** Resolution probe result (boundary data — schema-first). */
export const entityRefSchema = z.object({
  id: entityIdSchema,
  name: z.string(),
});
export type EntityRef = z.infer<typeof entityRefSchema>;

/**
 * An entity the store already holds whose name is spoken in a memory's text —
 * the result of deterministic anchoring (boundary data — schema-first).
 */
export const contentAnchorSchema = z.object({
  id: entityIdSchema,
  name: z.string(),
  type: z.string(),
});
export type ContentAnchor = z.infer<typeof contentAnchorSchema>;

export interface ListEntitiesParams {
  query?: string;
  scope?: Scope;
  limit?: number;
}

/**
 * Port: persistence of knowledge-graph nodes and memory mentions.
 *
 * ADD-only like the rest of the store: there is no delete; resolution merges
 * onto existing nodes instead of rewriting them.
 */
export interface IEntityRepository {
  /** Persists a new entity together with its name embedding. */
  insert(
    entity: Entity,
    nameEmbedding: number[]
  ): Promise<Result<void, string>>;

  /**
   * Exact resolution step: normalized name inside the exact scope.
   * `type: null` matches any type (the write path always resolves
   * type-agnostically — a same-name node under another type is the same
   * thing, not a new entity); ties resolve to the oldest entity.
   */
  findByNormalizedName(
    normalizedName: string,
    type: EntityType | null,
    scope: Scope
  ): Promise<Option<EntityRef>>;

  /**
   * Second resolution probe: the same name spelled differently. Matches on
   * `match_key` — lowercase, separator runs removed — inside the scope, so
   * "zero_memory" finds "zero-memory" while "TICKET-4210" does not
   * find "TICKET-4120". `type: null` matches any type, mirroring the exact probe, and
   * ties resolve to the oldest entity.
   *
   * This REPLACES a name-embedding cosine probe, which could not tell the two
   * cases apart: distinct subjects scored higher than genuine spelling
   * variants, so no threshold separated them.
   */
  findByMatchKey(
    matchKey: string,
    type: EntityType | null,
    scope: Scope
  ): Promise<Option<EntityRef>>;

  /**
   * Deterministic anchoring probe: entities ALREADY KNOWN in the exact scope
   * whose name is spoken — as a whole token, never as a substring — in the
   * given text. Longest name first, so the narrowest subject survives the
   * limit.
   *
   * Resolution only: it creates nothing. A subject the graph has never seen
   * is simply absent from the result, which is what leaves the naming of it
   * to the writing agent.
   */
  findContentAnchors(
    content: string,
    scope: Scope,
    minNameLength: number,
    limit: number
  ): Promise<ContentAnchor[]>;

  /** Records "this memory mentions this entity" (idempotent). */
  linkMemory(memoryId: string, entityId: string): Promise<Result<void, string>>;

  /** Lists/searches entities visible to the current user. */
  list(params: ListEntitiesParams): Promise<EntityHit[]>;

  /** Entities mentioned by each of the given memories (one query). */
  listForMemories(
    memoryIds: string[]
  ): Promise<ReadonlyMap<string, ContextEntity[]>>;
}
