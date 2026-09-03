import {
  edgeTypeSchema,
  entityIdSchema,
  entityTypeSchema,
  type BuildContextOutput,
  type MemoryLinkType,
  type RelatedMemory,
} from '@workspace/contracts';
import type { Result } from 'oxide.ts';
import { z } from 'zod';

import type { EdgeType } from './edge-type.vo.js';
import type { Scope } from './scope.vo.js';

/** Hard cap of the graph walk — mirrors the SQL guard in traverse_entities. */
export const TRAVERSE_MAX_DEPTH = 3;

/** Validated traversal parameters (boundary data — schema-first). */
export const traverseParamsSchema = z.object({
  startEntityId: entityIdSchema,
  maxDepth: z.number().int().min(1).max(TRAVERSE_MAX_DEPTH).default(2),
  edgeTypes: z.array(edgeTypeSchema).optional(),
});
export type TraverseParams = z.infer<typeof traverseParamsSchema>;

/** One node reached by the walk (depth 0 is the start node itself). */
export const traverseHopSchema = z.object({
  entity_id: entityIdSchema,
  name: z.string(),
  type: entityTypeSchema,
  depth: z.number().int(),
  via_edge_type: edgeTypeSchema.nullable(),
  path: z.array(entityIdSchema),
});
export type TraverseHop = z.infer<typeof traverseHopSchema>;

export interface CreateEdgeParams {
  srcEntityId: string;
  dstEntityId: string;
  type: EdgeType;
  scope: Scope;
  sourceMemoryId?: string;
}

export interface BuildContextParams {
  topicEmbedding: number[];
  topicText: string;
  scopes?: Scope[];
  maxMemories?: number;
  maxEntities?: number;
  /**
   * True for briefing calls: the pack gains the `recent[]` working-set leg
   * and hard-filters rules-promoted memories. Mid-session calls omit it.
   */
  briefing?: boolean;
}

export interface LinkCreated {
  /** False when an equivalent live link already existed. */
  created: boolean;
}

/**
 * Port: the knowledge graph around memories — entity edges, memory links,
 * traversal, and the one-call context briefing. Read paths are RLS-scoped
 * to the current user.
 */
export interface IGraphService {
  /** Creates a live entity->entity edge (idempotent per src/dst/type). */
  createEdge(params: CreateEdgeParams): Promise<Result<LinkCreated, string>>;

  /** Creates a memory->memory link (idempotent per src/dst/type). */
  linkMemories(
    srcMemoryId: string,
    dstMemoryId: string,
    type: MemoryLinkType
  ): Promise<Result<LinkCreated, string>>;

  /** Depth-limited, cycle-safe walk over live edges. */
  traverse(params: TraverseParams): Promise<TraverseHop[]>;

  /** Context briefing: memories + entities + edges + linked memories. */
  buildContext(params: BuildContextParams): Promise<BuildContextOutput>;

  /**
   * Typed-link neighbours of the given memories, both directions, at most
   * `perMemory` for each — the connective tissue a flat hit list omits.
   *
   * Returns STUBS (relation, kind, opening line, id), never bodies: the point
   * is that a caller learns a related fact EXISTS for almost no tokens and
   * pulls the ones it wants by id. Retired neighbours are excluded, so a
   * superseded predecessor is not offered as if it still held.
   */
  neighborsOf(
    memoryIds: readonly string[],
    perMemory: number
  ): Promise<RelatedMemory[]>;
}
