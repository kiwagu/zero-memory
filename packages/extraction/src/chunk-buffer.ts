/**
 * Chunking seam of the ingestion pipeline. v1 processes every chunk
 * immediately (`ZM_INGEST_BUFFER_TOKENS` defaults to 0); a future buffering
 * implementation can accumulate chunks per conversation up to a token budget
 * before releasing them — without touching IngestService.
 */
export interface IChunkBuffer {
  /** Offers a chunk; returns the chunks that are ready to process NOW. */
  push(conversationId: string, chunk: string): string[];
}

/** v1 behavior: every chunk is ready the moment it arrives. */
export class PassthroughChunkBuffer implements IChunkBuffer {
  push(_conversationId: string, chunk: string): string[] {
    return [chunk];
  }
}

/** Token budget after which buffered chunks would flush (0 = immediate). */
export const resolveIngestBufferTokens = (): number => {
  const raw = Number(process.env.ZM_INGEST_BUFFER_TOKENS ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
};
