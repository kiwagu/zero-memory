import { injectContext, type IContext } from '@workspace/context';
import {
  contextEntitySchema,
  entityHitSchema,
  entityIdSchema,
  memoryIdSchema,
  type ContextEntity,
  type EntityHit,
  type EntityType,
} from '@workspace/contracts';
import { singleton } from '@workspace/di';
import {
  contentAnchorSchema,
  type ContentAnchor,
  type Entity,
  type EntityRef,
  type IEntityRepository,
  type ListEntitiesParams,
  type Scope,
} from '@workspace/memory';
import { Err, None, Ok, Some, type Option, type Result } from 'oxide.ts';
import { z } from 'zod';

import { createUserClient, type Client } from '../supabase.client.js';

const DEFAULT_LIST_LIMIT = 50;

const entityRowSchema = z.object({
  id: entityIdSchema,
  name: z.string(),
});

const entityHitsSchema = z.array(entityHitSchema);

const mentionRowSchema = z.object({
  memory_id: memoryIdSchema,
  entities: contextEntitySchema,
});
const mentionRowsSchema = z.array(mentionRowSchema);

/**
 * Supabase adapter for the entity repository port. Every call runs as the
 * current user (JWT from the execution context), so RLS scopes both reads
 * and writes; nodes are ADD-only (no delete path).
 */
@singleton()
export class SupabaseEntityRepository implements IEntityRepository {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async insert(
    entity: Entity,
    nameEmbedding: number[]
  ): Promise<Result<void, string>> {
    const { error } = await this.#client()
      .from('entities')
      .insert({
        id: entity.id,
        name: entity.name,
        type: entity.type,
        scope: entity.scope.path,
        name_embedding: JSON.stringify(nameEmbedding),
      });
    if (error) {
      return Err(`Failed to insert entity "${entity.name}": ${error.message}`);
    }
    return Ok(undefined);
  }

  async findByNormalizedName(
    normalizedName: string,
    type: EntityType | null,
    scope: Scope
  ): Promise<Option<EntityRef>> {
    let query = this.#client()
      .from('entities')
      .select('id, name')
      .eq('normalized_name', normalizedName)
      .eq('scope', scope.path);
    if (type !== null) {
      query = query.eq('type', type);
    }
    // Type-agnostic lookups may hit several types: take the oldest node
    // deterministically.
    const { data, error } = await query
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) {
      throw new Error(`Failed to look up entity: ${error.message}`);
    }
    const row = data?.[0];
    if (!row) {
      return None;
    }
    return Some(entityRowSchema.parse(row));
  }

  async findByMatchKey(
    matchKey: string,
    type: EntityType | null,
    scope: Scope
  ): Promise<Option<EntityRef>> {
    // A plain indexed filter rather than an RPC: `match_key` is a stored
    // generated column, so the predicate compares a column to a parameter and
    // PostgREST can express it. `entities_scope_match_key_idx` serves it.
    let query = this.#client()
      .from('entities')
      .select('id, name')
      .eq('match_key', matchKey)
      .eq('scope', scope.path);
    if (type !== null) {
      query = query.eq('type', type);
    }
    // Same tie-break as the exact probe: the oldest node wins, so resolution
    // stays deterministic while duplicates await the hygiene merge.
    const { data, error } = await query
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) {
      throw new Error(
        `Failed to look up entity by match key: ${error.message}`
      );
    }
    const row = data?.[0];
    if (!row) {
      return None;
    }
    return Some(entityRowSchema.parse(row));
  }

  async findContentAnchors(
    content: string,
    scope: Scope,
    minNameLength: number,
    limit: number
  ): Promise<ContentAnchor[]> {
    // Whole-token containment, ordering and the scope bound all live in the
    // function: PostgREST cannot express a predicate that compares a COLUMN
    // against a parameter, and pulling the scope's entities out to match them
    // here would put a full table read on every write.
    const { data, error } = await this.#client().rpc('find_content_anchors', {
      content_text: content,
      scope_filter: scope.path,
      min_name_length: minNameLength,
      p_limit: limit,
    });
    if (error) {
      throw new Error(`find_content_anchors failed: ${error.message}`);
    }
    return z.array(contentAnchorSchema).parse(data ?? []);
  }

  async linkMemory(
    memoryId: string,
    entityId: string
  ): Promise<Result<void, string>> {
    // ON CONFLICT DO NOTHING: re-mentioning an entity is a no-op.
    const { error } = await this.#client()
      .from('memory_entities')
      .upsert(
        { memory_id: memoryId, entity_id: entityId },
        { onConflict: 'memory_id,entity_id', ignoreDuplicates: true }
      );
    if (error) {
      return Err(
        `Failed to link memory ${memoryId} to entity ${entityId}: ` +
          error.message
      );
    }
    return Ok(undefined);
  }

  async list(params: ListEntitiesParams): Promise<EntityHit[]> {
    let query = this.#client()
      .from('entities')
      .select('id, name, type, scope, created_at');
    if (params.query) {
      // Match on the resolution key so casing/spacing differences are moot.
      const needle = params.query.trim().toLowerCase().replace(/\s+/g, ' ');
      query = query.ilike('normalized_name', `%${needle}%`);
    }
    if (params.scope) {
      query = query.eq('scope', params.scope.path);
    }
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(params.limit ?? DEFAULT_LIST_LIMIT);
    if (error) {
      throw new Error(`Failed to list entities: ${error.message}`);
    }
    return entityHitsSchema.parse(data ?? []);
  }

  async listForMemories(
    memoryIds: string[]
  ): Promise<ReadonlyMap<string, ContextEntity[]>> {
    const mentions = new Map<string, ContextEntity[]>();
    if (memoryIds.length === 0) {
      return mentions;
    }
    const { data, error } = await this.#client()
      .from('memory_entities')
      .select('memory_id, entities (id, name, type)')
      .in('memory_id', memoryIds);
    if (error) {
      throw new Error(`Failed to load memory mentions: ${error.message}`);
    }
    for (const row of mentionRowsSchema.parse(data ?? [])) {
      const bucket = mentions.get(row.memory_id) ?? [];
      bucket.push(row.entities);
      mentions.set(row.memory_id, bucket);
    }
    return mentions;
  }

  #client(): Client {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      throw new Error('No access token in the execution context.');
    }
    return createUserClient(accessToken);
  }
}
