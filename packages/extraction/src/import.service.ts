import {
  IMPORT_CLIENT,
  IMPORT_SOURCE_KIND,
  internalFailure,
  validationFailed,
  type Failure,
  type ImportMemoryInput,
  type ImportMemoryOutput,
} from '@workspace/contracts';
import { inject, singleton } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import {
  MemoryService,
  ScopeRoutingService,
  type Scope,
} from '@workspace/memory';
import { Err, Ok, type Result } from 'oxide.ts';

import { injectIngestLogRepository } from './ingest-log.repository.provider.js';
import type { IIngestLogRepository } from './ingest-log.repository.js';

/**
 * Application service of the deterministic bootstrap-import path. Native
 * memories (Claude Code auto-memory files, CLAUDE.md sections) are already
 * atomic facts, so this bypasses LLM extraction entirely and writes them
 * straight through `MemoryService.remember`:
 *
 *   (a) idempotency via the ingest log (same `source_hash` -> no-op, no re-embed)
 *   (b) scope routing done SERVER-SIDE (the client cannot build `user.<uid>`):
 *       personal / core / project-from-hint
 *   (c) an authoritative agent write (agent_name null -> rank 1) stamped
 *       `source.kind = "import"`, so a later watcher paraphrase defers to the
 *       curated import; the existing cosine dedup still collapses paraphrases
 *   (d) the ledger row is marked processed with the created count.
 *
 * Auto-share is deliberately NOT applied: an imported fact keeps the owner's
 * private visibility (widening a scope is an explicit `share`).
 */
@singleton()
export class ImportService {
  readonly #logger = createLogger(ImportService.name);

  constructor(
    @inject(MemoryService)
    private readonly memoryService: MemoryService,
    @inject(ScopeRoutingService)
    private readonly scopeRouting: ScopeRoutingService,
    @injectIngestLogRepository()
    private readonly ingestLog: IIngestLogRepository
  ) {}

  async import(
    input: ImportMemoryInput
  ): Promise<Result<ImportMemoryOutput, Failure>> {
    // (a) Idempotency: claim the source hash before any work. A re-import is a
    // no-op WITHOUT re-embedding — cheaper and more precise than leaning on the
    // cosine dedup alone. The client tag keeps import rows off the watcher's.
    const claimed = await this.ingestLog.insertIfAbsent({
      chunkHash: input.source_hash,
      client: IMPORT_CLIENT,
      conversationId: input.source_path,
    });
    if (claimed.isErr()) {
      return Err(internalFailure(claimed.unwrapErr()));
    }
    if (claimed.unwrap().existed) {
      return Ok({ skipped: true });
    }

    // (b) Scope routing. Any failure MUST release the claim so a corrected
    // re-run is not swallowed as a duplicate.
    const scopeResult = await this.#resolveScope(input);
    if (scopeResult.isErr()) {
      await this.#release(input.source_hash);
      return Err(scopeResult.unwrapErr());
    }
    const scope = scopeResult.unwrap();

    // (c) Deterministic authoritative write, stamped source.kind = 'import'.
    const remembered = await this.memoryService.remember(
      {
        content: input.content,
        kind: input.kind,
        scope: scope.path,
        ...(input.verbatim ? { verbatim: input.verbatim } : {}),
      },
      {
        source: {
          kind: IMPORT_SOURCE_KIND,
          // The originating tool (claude-code, cursor, ...) when the adapter
          // supplied it — keeps imports filterable by origin.
          ...(input.source_tool ? { tool: input.source_tool } : {}),
          path: input.source_path,
          hash: input.source_hash,
        },
      }
    );
    if (remembered.isErr()) {
      await this.#release(input.source_hash);
      return Err(remembered.unwrapErr());
    }
    const output = remembered.unwrap();

    // (d) Close the ledger row (best effort — the memory is stored).
    const created = output.deduplicated ? 0 : 1;
    const marked = await this.ingestLog.markProcessed(
      input.source_hash,
      created
    );
    if (marked.isErr()) {
      this.#logger.warn('failed to mark import ledger row processed', {
        sourceHash: input.source_hash,
        error: marked.unwrapErr(),
      });
    }

    this.#logger.info('memory imported', {
      sourcePath: input.source_path,
      scope: scope.path,
      deduplicated: output.deduplicated ?? false,
    });
    return Ok({
      skipped: false,
      memory_id: output.memory_id,
      ...(output.deduplicated ? { deduplicated: true } : {}),
    });
  }

  /** Intent -> concrete scope. Personal/core need no hint; project requires one. */
  async #resolveScope(
    input: ImportMemoryInput
  ): Promise<Result<Scope, Failure>> {
    if (input.target === 'personal') {
      return Ok(this.scopeRouting.personalScope());
    }
    if (input.target === 'core') {
      return Ok(this.scopeRouting.coreScope());
    }
    if (!input.project_hint) {
      return Err(
        validationFailed('project_hint is required when target is "project".')
      );
    }
    return Ok(await this.scopeRouting.resolveProjectScope(input.project_hint));
  }

  async #release(sourceHash: string): Promise<void> {
    const released = await this.ingestLog.release(sourceHash);
    if (released.isErr()) {
      this.#logger.error('failed to release import claim', {
        sourceHash,
        error: released.unwrapErr(),
      });
    }
  }
}
