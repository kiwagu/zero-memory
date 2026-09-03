import { injectContext, type IContext } from '@workspace/context';
import type { Json } from '@workspace/db';
import { singleton } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import {
  MemoryMapper,
  memoryFragmentRecordSchema,
  type IMemoryRepository,
  type MemoryFragment,
  type PassageVectors,
} from '@workspace/memory';
import { Err, None, Ok, Some, type Option, type Result } from 'oxide.ts';

import { createUserClient, type Client } from '../supabase.client.js';

/** All columns of a memory row except the heavy ones (embedding, fts). */
const MEMORY_COLUMNS =
  'id, content, kind, scope, visibility, owner_id, author_kind, agent_name, ' +
  'source, content_original, content_lang, translation_status, ' +
  'translation_attempts, translation_error, valid_from, invalidated_at, ' +
  'invalidated_by, superseded_by, shared_at, shared_by, created_at';

/**
 * Supabase adapter for the memory repository port. Every call runs as the
 * current user (JWT from the execution context), so RLS is the enforcement
 * boundary — including the absence of any delete path for `memories` itself
 * (ADD-only table). Its DERIVED overflow windows are replaceable, since they
 * describe content rather than record it.
 *
 * User columns (owner_id / invalidated_by / shared_by) hold the domain `usr_`
 * id directly, so the mapper record round-trips them with no translation.
 */
@singleton()
export class SupabaseMemoryRepository implements IMemoryRepository {
  readonly #mapper = new MemoryMapper();

  readonly #logger = createLogger(SupabaseMemoryRepository.name);

  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async insert(
    fragment: MemoryFragment,
    vectors: PassageVectors
  ): Promise<Result<void, string>> {
    const record = this.#mapper.toEntity(fragment);
    const { error } = await this.#client()
      .from('memories')
      .insert({
        ...record,
        // Free-form provenance object narrows to the DB Json type.
        source: record.source as Json,
        embedding: JSON.stringify(vectors.primary),
      });
    if (error) {
      return Err(`Failed to insert memory: ${error.message}`);
    }
    await this.#writeChunks(fragment.id, vectors.overflow);
    return Ok(undefined);
  }

  /**
   * Persists the overflow windows of a memory that is already stored.
   *
   * Deliberately NOT fatal to the write: the memory row has landed by the time
   * this runs, so failing the call would report an error for a memory that
   * exists and invite a retry that writes it twice. Missing chunks degrade one
   * record to opening-only search — the state everything was in before they
   * existed — and the backfill pass repairs them idempotently.
   */
  async #writeChunks(
    memoryId: string,
    overflow: PassageVectors['overflow']
  ): Promise<void> {
    if (overflow.length === 0) {
      return;
    }
    const { error } = await this.#client()
      .from('memory_chunks')
      .insert(
        overflow.map((window, ord) => ({
          memory_id: memoryId,
          ord,
          char_start: window.charStart,
          embedding: JSON.stringify(window.embedding),
        }))
      );
    if (error) {
      this.#logger.warn('memory stored without its overflow windows', {
        id: memoryId,
        windows: overflow.length,
        error: error.message,
      });
    }
  }

  /** Drops a memory's overflow windows and writes the ones its content needs now. */
  async #replaceChunks(
    memoryId: string,
    overflow: PassageVectors['overflow']
  ): Promise<void> {
    const { error } = await this.#client()
      .from('memory_chunks')
      .delete()
      .eq('memory_id', memoryId);
    if (error) {
      this.#logger.warn('stale overflow windows left behind', {
        id: memoryId,
        error: error.message,
      });
      return;
    }
    await this.#writeChunks(memoryId, overflow);
  }

  async findOneById(id: string): Promise<Option<MemoryFragment>> {
    const { data, error } = await this.#client()
      .from('memories')
      .select(MEMORY_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load memory ${id}: ${error.message}`);
    }
    if (!data) {
      return None;
    }
    const record = memoryFragmentRecordSchema.parse(data);
    return Some(this.#mapper.toDomain(record));
  }

  async update(fragment: MemoryFragment): Promise<Result<void, string>> {
    const record = this.#mapper.toEntity(fragment);
    const { data, error } = await this.#client()
      .from('memories')
      .update({
        // Sharing widens the scope together with the visibility flip.
        scope: record.scope,
        visibility: record.visibility,
        invalidated_at: record.invalidated_at,
        invalidated_by: record.invalidated_by,
        superseded_by: record.superseded_by,
        shared_at: record.shared_at,
        shared_by: record.shared_by,
      })
      .eq('id', fragment.id)
      .select('id');
    if (error) {
      return Err(`Failed to update memory ${fragment.id}: ${error.message}`);
    }
    if (!data || data.length === 0) {
      return Err(
        `Memory ${fragment.id} was not updated (not found or not permitted).`
      );
    }
    return Ok(undefined);
  }

  async applyTranslation(
    id: string,
    params: {
      content: string;
      contentOriginal: string;
      contentLang: string;
      vectors: PassageVectors;
    }
  ): Promise<Result<void, string>> {
    const { data, error } = await this.#client()
      .from('memories')
      .update({
        content: params.content,
        content_original: params.contentOriginal,
        content_lang: params.contentLang,
        translation_status: 'done',
        translation_error: null,
        embedding: JSON.stringify(params.vectors.primary),
      })
      .eq('id', id)
      .select('id');
    if (error) {
      return Err(`Failed to apply translation to ${id}: ${error.message}`);
    }
    if (!data || data.length === 0) {
      return Err(`Memory ${id} was not updated (not found or not permitted).`);
    }
    // The content changed, so the old windows describe text that is no longer
    // stored. Replaced rather than merged: the English rendering can need a
    // different NUMBER of windows than the original did.
    await this.#replaceChunks(id, params.vectors.overflow);
    return Ok(undefined);
  }

  async markTranslationSkipped(id: string): Promise<Result<void, string>> {
    const { data, error } = await this.#client()
      .from('memories')
      .update({
        translation_status: 'skipped',
        content_original: null,
        content_lang: 'en',
        translation_error: null,
      })
      .eq('id', id)
      .select('id');
    if (error) {
      return Err(`Failed to skip translation for ${id}: ${error.message}`);
    }
    if (!data || data.length === 0) {
      return Err(`Memory ${id} was not updated (not found or not permitted).`);
    }
    return Ok(undefined);
  }

  #client(): Client {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      throw new Error('No access token in the execution context.');
    }
    return createUserClient(accessToken);
  }
}
