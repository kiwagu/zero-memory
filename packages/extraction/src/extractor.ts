import type { IngestSourceKind } from '@workspace/contracts';

import type { ExtractionResult } from './extraction.schema.js';

/**
 * Port: turns a raw text chunk into candidate memories (with their entity
 * mentions and relations). The chunk is a conversation transcript by default;
 * `sourceKind` switches the extraction policy for repo-bootstrap sources
 * (`document` — README/docs page, `history` — a git-log slice).
 * Implementations must return a value that already validated against
 * `extractionResultSchema`.
 */
export interface IExtractor {
  extract(
    transcript: string,
    sourceKind?: IngestSourceKind
  ): Promise<ExtractionResult>;
}
