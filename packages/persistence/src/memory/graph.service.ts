import { injectContext, type IContext } from '@workspace/context';
import {
  buildContextOutputSchema,
  type BuildContextOutput,
  type MemoryLinkType,
  type RelatedMemory,
} from '@workspace/contracts';
import { singleton } from '@workspace/di';
import {
  traverseHopSchema,
  type BuildContextParams,
  type CreateEdgeParams,
  type IGraphService,
  type LinkCreated,
  type TraverseHop,
  type TraverseParams,
} from '@workspace/memory';
import { Err, Ok, type Result } from 'oxide.ts';
import { z } from 'zod';

import { createUserClient, type Client } from '../supabase.client.js';

/** Postgres unique_violation — the live edge already exists (lost race). */
const UNIQUE_VIOLATION = '23505';

const traverseHopsSchema = z.array(traverseHopSchema);

/** The embedded endpoint a link row carries, as PostgREST returns it. */
const linkEndpointSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    content: z.string(),
    invalidated_at: z.string().nullable(),
  })
  .nullable();

/** Link rows with both endpoints embedded — the shape `neighborsOf` reads. */
const linkRowsSchema = z.array(
  z.object({
    src: z.string(),
    dst: z.string(),
    type: z.enum(['relates_to', 'supersedes', 'contradicts', 'derived_from']),
    src_memory: linkEndpointSchema,
    dst_memory: linkEndpointSchema,
  })
);

/**
 * Supabase adapter for the graph port: edge/link writes through the RLS
 * fence and thin wrappers over the security-invoker graph RPCs.
 */
@singleton()
export class SupabaseGraphService implements IGraphService {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async createEdge(
    params: CreateEdgeParams
  ): Promise<Result<LinkCreated, string>> {
    const client = this.#client();

    // The partial unique index (live rows only) cannot be targeted by
    // PostgREST upserts, so probe first and treat a racing 23505 as "exists".
    const { data: existing, error: probeError } = await client
      .from('edges')
      .select('id')
      .eq('src', params.srcEntityId)
      .eq('dst', params.dstEntityId)
      .eq('type', params.type.value)
      .is('invalidated_at', null)
      .maybeSingle();
    if (probeError) {
      return Err(`Failed to probe for an edge: ${probeError.message}`);
    }
    if (existing) {
      return Ok({ created: false });
    }

    const { error } = await client.from('edges').insert({
      src: params.srcEntityId,
      dst: params.dstEntityId,
      type: params.type.value,
      scope: params.scope.path,
      source_memory: params.sourceMemoryId,
    });
    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        return Ok({ created: false });
      }
      return Err(`Failed to create edge: ${error.message}`);
    }
    return Ok({ created: true });
  }

  async linkMemories(
    srcMemoryId: string,
    dstMemoryId: string,
    type: MemoryLinkType
  ): Promise<Result<LinkCreated, string>> {
    // ON CONFLICT DO NOTHING on the (src, dst, type) primary key; ask for
    // the row back to learn whether this call inserted it.
    const { data, error } = await this.#client()
      .from('memory_links')
      .upsert(
        { src: srcMemoryId, dst: dstMemoryId, type },
        { onConflict: 'src,dst,type', ignoreDuplicates: true }
      )
      .select('src');
    if (error) {
      return Err(
        `Failed to link memory ${srcMemoryId} to ${dstMemoryId}: ` +
          error.message
      );
    }
    return Ok({ created: (data ?? []).length > 0 });
  }

  async traverse(params: TraverseParams): Promise<TraverseHop[]> {
    const { data, error } = await this.#client().rpc('traverse_entities', {
      start_entity: params.startEntityId,
      max_depth: params.maxDepth,
      edge_types: params.edgeTypes,
    });
    if (error) {
      throw new Error(`traverse_entities failed: ${error.message}`);
    }
    return traverseHopsSchema.parse(data ?? []);
  }

  async neighborsOf(
    memoryIds: readonly string[],
    perMemory: number
  ): Promise<RelatedMemory[]> {
    if (memoryIds.length === 0 || perMemory <= 0) {
      return [];
    }
    const ids = [...memoryIds];
    const client = this.#client();
    // Both directions in one round trip. RLS applies to memory_links (both
    // endpoints must be visible) and again to the embedded memory, so a
    // neighbour the caller may not read simply does not come back.
    // No whitespace anywhere in the select: PostgREST parses this string
    // literally, and a single space before an embed's parenthesis makes the
    // whole request fail.
    const columns =
      'src,dst,type,' +
      'src_memory:memories!memory_links_src_fkey(id,kind,content,invalidated_at),' +
      'dst_memory:memories!memory_links_dst_fkey(id,kind,content,invalidated_at)';
    const { data, error } = await client
      .from('memory_links')
      .select(columns)
      .or(`src.in.(${ids.join(',')}),dst.in.(${ids.join(',')})`);
    if (error) {
      // Throw rather than return empty: the caller degrades this to "no
      // relations" AND logs it. Swallowing it here once hid a broken query
      // behind a plausible-looking empty result.
      throw new Error(`Failed to read memory links: ${error.message}`);
    }

    const hits = new Set(ids);
    const perHit = new Map<string, number>();
    const related: RelatedMemory[] = [];
    for (const row of linkRowsSchema.parse(data ?? [])) {
      const fromSrc = hits.has(row.src);
      const of = fromSrc ? row.src : row.dst;
      const neighbor = fromSrc ? row.dst_memory : row.src_memory;
      if (!neighbor || neighbor.invalidated_at !== null) continue;
      // A hit related to another hit is already in the answer.
      if (hits.has(neighbor.id)) continue;
      const taken = perHit.get(of) ?? 0;
      if (taken >= perMemory) continue;
      perHit.set(of, taken + 1);
      related.push({
        id: neighbor.id,
        of,
        relation: row.type,
        kind: neighbor.kind,
        preview: neighbor.content.replace(/\s+/gu, ' ').trim().slice(0, 120),
      } as RelatedMemory);
    }
    return related;
  }

  async buildContext(params: BuildContextParams): Promise<BuildContextOutput> {
    const { data, error } = await this.#client().rpc('build_context', {
      topic_embedding: JSON.stringify(params.topicEmbedding),
      topic_text: params.topicText,
      scope_filter: params.scopes?.map((scope) => scope.path),
      max_memories: params.maxMemories,
      max_entities: params.maxEntities,
      // Omitted for mid-session calls: the SQL default (false) keeps the
      // pre-recency behavior.
      ...(params.briefing ? { briefing: true } : {}),
    });
    if (error) {
      throw new Error(`build_context failed: ${error.message}`);
    }
    return buildContextOutputSchema.parse(data);
  }

  #client(): Client {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      throw new Error('No access token in the execution context.');
    }
    return createUserClient(accessToken);
  }
}
