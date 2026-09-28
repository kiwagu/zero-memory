import { Ok } from 'oxide.ts';
import { vi } from 'vitest';

import type {
  IIngestLogRepository,
  IngestLogEntry,
} from './ingest-log.repository.js';

/**
 * In-memory ingest log honouring the claim contract: insert-if-absent
 * reports whether the hash was already claimed, and release frees it for a
 * retry. `hashes` exposes the claimed set; `seeded` pre-claims hashes.
 *
 * Spec support only (it imports vitest) and deliberately not exported from
 * the package.
 */
export const makeIngestLog = (
  seeded: string[] = []
): IIngestLogRepository & { hashes: Set<string> } => {
  const hashes = new Set<string>(seeded);
  return {
    hashes,
    insertIfAbsent: vi.fn().mockImplementation((entry: IngestLogEntry) => {
      const existed = hashes.has(entry.chunkHash);
      hashes.add(entry.chunkHash);
      return Promise.resolve(Ok({ existed }));
    }),
    exists: vi
      .fn()
      .mockImplementation((chunkHash: string) =>
        Promise.resolve(Ok(hashes.has(chunkHash)))
      ),
    markProcessed: vi.fn().mockResolvedValue(Ok(undefined)),
    release: vi.fn().mockImplementation((chunkHash: string) => {
      hashes.delete(chunkHash);
      return Promise.resolve(Ok(undefined));
    }),
  };
};
