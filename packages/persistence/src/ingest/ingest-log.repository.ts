import { injectContext, type IContext } from '@workspace/context';
import { singleton } from '@workspace/di';
import type {
  IIngestLogRepository,
  IngestLogEntry,
} from '@workspace/extraction';
import { Err, Ok, type Result } from 'oxide.ts';

import { createUserClient, type Client } from '../supabase.client.js';

/**
 * Supabase adapter for the ingest-log port. insertIfAbsent maps to an
 * ON CONFLICT DO NOTHING upsert on the chunk_hash primary key: an empty
 * returning set means the hash was already claimed (idempotent duplicate).
 * Owner-only RLS covers reads and the processed-at update.
 */
@singleton()
export class SupabaseIngestLogRepository implements IIngestLogRepository {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async insertIfAbsent(
    entry: IngestLogEntry
  ): Promise<Result<{ existed: boolean }, string>> {
    const { data, error } = await this.#client()
      .from('ingest_log')
      .upsert(
        {
          chunk_hash: entry.chunkHash,
          client: entry.client,
          conversation_id: entry.conversationId,
        },
        { onConflict: 'chunk_hash', ignoreDuplicates: true }
      )
      .select('chunk_hash');
    if (error) {
      return Err(`Failed to claim ingest chunk: ${error.message}`);
    }
    return Ok({ existed: (data ?? []).length === 0 });
  }

  async exists(chunkHash: string): Promise<Result<boolean, string>> {
    // maybeSingle: owner-only RLS already scopes the row, and "not found" is
    // a normal answer here (the chunk is new), not an error.
    const { data, error } = await this.#client()
      .from('ingest_log')
      .select('chunk_hash')
      .eq('chunk_hash', chunkHash)
      .maybeSingle();
    if (error) {
      return Err(`Failed to probe ingest chunk: ${error.message}`);
    }
    return Ok(data !== null);
  }

  async markProcessed(
    chunkHash: string,
    memoriesCreated: number
  ): Promise<Result<void, string>> {
    const { error } = await this.#client()
      .from('ingest_log')
      .update({
        processed_at: new Date().toISOString(),
        memories_created: memoriesCreated,
      })
      .eq('chunk_hash', chunkHash);
    if (error) {
      return Err(
        `Failed to mark ingest chunk ${chunkHash} processed: ${error.message}`
      );
    }
    return Ok(undefined);
  }

  async release(chunkHash: string): Promise<Result<void, string>> {
    const { error } = await this.#client()
      .from('ingest_log')
      .delete()
      .eq('chunk_hash', chunkHash);
    if (error) {
      return Err(
        `Failed to release ingest chunk ${chunkHash}: ${error.message}`
      );
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
