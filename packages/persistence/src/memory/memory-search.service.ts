import { injectContext, type IContext } from '@workspace/context';
import {
  memorySearchHitSchema,
  type MemorySearchHit,
} from '@workspace/contracts';
import { singleton } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import {
  isFastLayer,
  similarMemorySchema,
  similarMemoryWithProvenanceSchema,
  staleDays,
  supersedeCandidateHitSchema,
  type IMemorySearchService,
  type MemorySearchParams,
  type Scope,
  type SimilarMemory,
  type SimilarMemoryWithProvenance,
  type SupersedeCandidateHit,
} from '@workspace/memory';
import { None, Some, type Option } from 'oxide.ts';
import { z } from 'zod';

import { createUserClient, type Client } from '../supabase.client.js';

const searchResultsSchema = z.array(memorySearchHitSchema);

/**
 * Supabase adapter for the memory search port: thin wrappers over the
 * security-invoker RPCs (RLS scopes every result to the current user).
 */
@singleton()
export class SupabaseMemorySearchService implements IMemorySearchService {
  readonly #logger = createLogger(SupabaseMemorySearchService.name);

  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async search(params: MemorySearchParams): Promise<MemorySearchHit[]> {
    const startedAt = performance.now();
    const { data, error } = await this.#client().rpc('search_memories', {
      query_embedding: JSON.stringify(params.queryEmbedding),
      query_text: params.queryText,
      scope_filter: params.scopes?.map((scope) => scope.path),
      k: params.k,
      kinds: params.kinds,
    });
    if (error) {
      throw new Error(`search_memories failed: ${error.message}`);
    }
    const hits = searchResultsSchema.parse(data ?? []);
    const annotated = await this.#annotateStaleness(hits);
    this.#logger.debug('hybrid search complete', {
      hits: hits.length,
      k: params.k,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    return annotated;
  }

  /**
   * Marks fast-layer hits whose last external check is past its budget, so a
   * session that actually needs the fact re-checks it in passing — the lazy
   * half of re-verification. Ranking is untouched: a stale fact still stands
   * until something better replaces it, and staleness must not quietly bury
   * it. Costs one extra read, and only when such hits are present at all.
   * Best-effort: a lookup failure leaves the hits unannotated rather than
   * failing the recall the caller actually asked for.
   */
  async #annotateStaleness(
    hits: MemorySearchHit[]
  ): Promise<MemorySearchHit[]> {
    const candidates = hits.filter((hit) => isFastLayer(hit));
    if (candidates.length === 0) {
      return hits;
    }
    const { data, error } = await this.#client()
      .from('memory_verification')
      .select('memory_id, last_verified_at')
      .in(
        'memory_id',
        candidates.map((hit) => hit.id)
      );
    if (error) {
      this.#logger.warn('staleness lookup failed; hits left unannotated', {
        error: error.message,
      });
      return hits;
    }
    const checkedAt = new Map(
      (data ?? []).map((row) => [row.memory_id, row.last_verified_at])
    );
    const now = new Date();
    return hits.map((hit) => {
      const days = staleDays(
        { ...hit, last_verified_at: checkedAt.get(hit.id) },
        now
      );
      return days === null ? hit : { ...hit, stale_days: days };
    });
  }

  async findSimilar(
    embedding: number[],
    scope: Scope,
    threshold?: number,
    windows?: number[][]
  ): Promise<Option<SimilarMemoryWithProvenance>> {
    const { data, error } = await this.#client().rpc('find_similar_memory', {
      query_embedding: JSON.stringify(embedding),
      scope_filter: scope.path,
      threshold,
      query_windows: windows?.map((window) => JSON.stringify(window)),
    });
    if (error) {
      throw new Error(`find_similar_memory failed: ${error.message}`);
    }
    const row = data?.[0];
    if (!row) {
      return None;
    }
    return Some(similarMemoryWithProvenanceSchema.parse(row));
  }

  async findAuthoritativeCoverage(
    embedding: number[],
    threshold?: number
  ): Promise<Option<SimilarMemory>> {
    const { data, error } = await this.#client().rpc(
      'find_authoritative_coverage',
      {
        query_embedding: JSON.stringify(embedding),
        min_similarity: threshold,
      }
    );
    if (error) {
      throw new Error(`find_authoritative_coverage failed: ${error.message}`);
    }
    const row = data?.[0];
    if (!row) {
      return None;
    }
    return Some(similarMemorySchema.parse(row));
  }

  async findSupersedeCandidates(
    embedding: number[],
    options?: {
      minSimilarity?: number;
      maxSimilarity?: number;
      limit?: number;
    }
  ): Promise<SupersedeCandidateHit[]> {
    const { data, error } = await this.#client().rpc(
      'find_supersede_candidates',
      {
        query_embedding: JSON.stringify(embedding),
        min_similarity: options?.minSimilarity,
        max_similarity: options?.maxSimilarity,
        p_limit: options?.limit,
      }
    );
    if (error) {
      throw new Error(`find_supersede_candidates failed: ${error.message}`);
    }
    return z.array(supersedeCandidateHitSchema).parse(data ?? []);
  }

  async listRecentByScope(
    scope: Scope,
    limit: number
  ): Promise<Array<{ content: string; kind: string }>> {
    const { data, error } = await this.#client()
      .from('memories')
      .select('content, kind')
      .eq('scope', scope.path)
      .is('invalidated_at', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      throw new Error(`listRecentByScope failed: ${error.message}`);
    }
    return data ?? [];
  }

  #client(): Client {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      throw new Error('No access token in the execution context.');
    }
    return createUserClient(accessToken);
  }
}
