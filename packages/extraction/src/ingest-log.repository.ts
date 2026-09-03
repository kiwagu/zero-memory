import type { Result } from 'oxide.ts';

export interface IngestLogEntry {
  chunkHash: string;
  client: string;
  conversationId: string;
}

/**
 * Port: the transport-idempotency ledger of the ingestion pipeline. One row
 * per transcript chunk, keyed by the chunk's content hash.
 */
export interface IIngestLogRepository {
  /**
   * Claims a chunk hash. `existed: true` means the chunk was already
   * ingested (by anyone) and must be skipped.
   */
  insertIfAbsent(
    entry: IngestLogEntry
  ): Promise<Result<{ existed: boolean }, string>>;

  /**
   * Read-only counterpart of `insertIfAbsent`: is this hash already in the
   * ledger? Deliberately does NOT claim — a preview must be able to ask
   * "would this chunk be new?" without making it a duplicate for the real
   * run that follows.
   */
  exists(chunkHash: string): Promise<Result<boolean, string>>;

  /** Marks the caller's row processed and records how many memories it made. */
  markProcessed(
    chunkHash: string,
    memoriesCreated: number
  ): Promise<Result<void, string>>;

  /**
   * Releases a claim after a processing failure so a retry of the same chunk
   * is NOT treated as a duplicate. Without this a transient extraction error
   * would permanently swallow the chunk (claimed-but-never-processed).
   */
  release(chunkHash: string): Promise<Result<void, string>>;
}
