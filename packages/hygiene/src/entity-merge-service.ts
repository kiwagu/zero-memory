import { createLogger } from '@workspace/logger';
import {
  createServiceRoleClient,
  readAllPages,
  type Client,
} from '@workspace/persistence';

import {
  clusterEntities,
  type EntityCluster,
  type EntityNode,
} from './entity-merge.js';

export interface EntityMergeResult {
  /** Entities examined. */
  scanned: number;
  /** Exact-name clusters found (more than one member). */
  clusters: number;
  /** Duplicate nodes merged away. */
  merged: number;
  /** Memory mentions repointed to canonical nodes. */
  mentionsMoved: number;
  /** Edges repointed to canonical nodes (self-loops dropped on the way). */
  edgesMoved: number;
}

type EntityRow = {
  id: string;
  name: string;
  type: string;
  scope: string;
  created_at: string;
};

type MergeCounters = {
  mentions_moved: number;
  edges_moved: number;
  edges_dropped: number;
  duplicates_deleted: number;
};

const AGENT_NAME = 'entity-merge';

/**
 * Server-side, service-role entity-merge pass. Runs in the hygiene cycle
 * next to the scanner: finds exact canonical-name clusters per scope,
 * merges each into its best-connected node through the atomic
 * `merge_entities` RPC, and records every merge in the audit log. Free of
 * LLM calls — reads plus one RPC per cluster.
 */
export class EntityMergeService {
  readonly #logger = createLogger('EntityMergeService');

  constructor(private readonly client: Client = createServiceRoleClient()) {}

  async merge(): Promise<EntityMergeResult> {
    const nodes = await this.#loadNodes();
    const clusters = clusterEntities(nodes);

    const result: EntityMergeResult = {
      scanned: nodes.length,
      clusters: clusters.length,
      merged: 0,
      mentionsMoved: 0,
      edgesMoved: 0,
    };

    for (const cluster of clusters) {
      const counters = await this.#mergeCluster(cluster);
      result.merged += counters.duplicates_deleted;
      result.mentionsMoved += counters.mentions_moved;
      result.edgesMoved += counters.edges_moved;
    }

    this.#logger.info('entity merge complete', { ...result });
    return result;
  }

  async #mergeCluster(cluster: EntityCluster): Promise<MergeCounters> {
    const duplicateIds = cluster.duplicates.map((node) => node.id);
    const { data, error } = await this.client.rpc('merge_entities', {
      p_canonical: cluster.canonical.id,
      p_duplicates: duplicateIds,
      // Only retype when the dominant type differs from what the canonical
      // already carries.
      ...(cluster.type !== cluster.canonical.type
        ? { p_type: cluster.type }
        : {}),
    });
    if (error) {
      throw new Error(
        `entity merge: cluster "${cluster.key}" in ${cluster.scope} failed: ` +
          error.message
      );
    }
    const counters = data as MergeCounters;

    await this.#audit(cluster, counters);
    return counters;
  }

  /** Live entities with their connectivity degree (mentions + live edges). */
  async #loadNodes(): Promise<EntityNode[]> {
    // Paged: an unpaginated select silently returned only PostgREST's first
    // 1000 rows, so this service merged the first thousand nodes of a larger
    // graph and reported success — measured on a 1744-node graph 2026-08-19.
    const rows = (await readAllPages(
      (from, to) =>
        this.client
          .from('entities')
          .select('id, name, type, scope, created_at')
          .order('id', { ascending: true })
          .range(from, to),
      { label: 'entity merge: loading entities' }
    )) as EntityRow[];
    if (rows.length === 0) {
      return [];
    }

    const degree = new Map<string, number>();
    const bump = (id: string): void => {
      degree.set(id, (degree.get(id) ?? 0) + 1);
    };

    const mentions = await readAllPages(
      (from, to) =>
        this.client
          .from('memory_entities')
          .select('entity_id')
          .order('entity_id', { ascending: true })
          .range(from, to),
      { label: 'entity merge: loading mentions' }
    );
    for (const row of mentions) {
      bump(row.entity_id);
    }

    const edges = await readAllPages(
      (from, to) =>
        this.client
          .from('edges')
          .select('src, dst')
          .is('invalidated_at', null)
          .order('src', { ascending: true })
          .range(from, to),
      { label: 'entity merge: loading edges' }
    );
    for (const row of edges) {
      bump(row.src);
      bump(row.dst);
    }

    return rows.map((row) => ({ ...row, degree: degree.get(row.id) ?? 0 }));
  }

  async #audit(cluster: EntityCluster, counters: MergeCounters): Promise<void> {
    const { error } = await this.client.from('audit_log').insert({
      command: 'HygieneEntityMerge',
      payload: {
        canonical: cluster.canonical.id,
        name: cluster.canonical.name,
        type: cluster.type,
        scope: cluster.scope,
        duplicates: cluster.duplicates.map((node) => ({
          id: node.id,
          name: node.name,
          type: node.type,
        })),
        ...counters,
      },
      outcome: 'ok',
      author_kind: 'agent',
      agent_name: AGENT_NAME,
    });
    if (error) {
      // Audit is best-effort context, not the operation itself.
      this.#logger.warn('entity merge: audit write failed', {
        error: error.message,
      });
    }
  }
}
