import type { EntityId, EntityType } from '@workspace/contracts';
import { singleton } from '@workspace/di';
import {
  injectEmbeddingService,
  type IEmbeddingService,
} from '@workspace/embedding';
import { createLogger } from '@workspace/logger';
import { Err, Ok, type Result } from 'oxide.ts';

import { Entity, entityMatchKey, normalizeEntityName } from './entity.do.js';
import { injectEntityRepository } from './entity.repository.provider.js';
import type { IEntityRepository } from './entity.repository.js';
import type { Scope } from './scope.vo.js';

// A name-embedding cosine floor used to stand here. It was removed rather
// than retuned: measured on the live corpus, distinct subjects scored HIGHER
// than genuine spelling variants, so no floor could separate them. See
// `entityMatchKey`, which does the same job deterministically.

export interface ResolvedEntity {
  entityId: EntityId;
  name: string;
  /** True when no existing node matched and a new one was created. */
  created: boolean;
}

/**
 * Deterministic entity resolution (DESIGN §6.6), no LLM and no vector search:
 *
 *   normalize name -> exact (normalized_name, type, scope) match
 *   -> same name spelled differently (match_key) within the scope -> attach
 *   -> otherwise create a new entity.
 *
 * Both probes are EXACT. That is the whole design: a subject the caller named
 * is either a name the scope already holds, in one spelling or another, or it
 * is new. Nothing is resolved by resemblance, because resemblance could not
 * tell "TICKET-4210" from "TICKET-4120".
 */
@singleton()
export class EntityResolutionService {
  readonly #logger = createLogger(EntityResolutionService.name);

  constructor(
    @injectEntityRepository()
    private readonly repository: IEntityRepository,
    @injectEmbeddingService()
    private readonly embeddingService: IEmbeddingService
  ) {}

  /**
   * `type: null` means the caller only knows the name (the `link` tool):
   * the exact probe then matches any type, and a newly created entity
   * defaults to `concept`.
   */
  async resolve(
    name: string,
    type: EntityType | null,
    scope: Scope
  ): Promise<Result<ResolvedEntity, string>> {
    const displayName = normalizeEntityName(name);
    if (displayName.length === 0) {
      return Err('Entity name must not be empty.');
    }
    const normalizedName = displayName.toLowerCase();
    const fallbackType: EntityType = type ?? 'concept';

    // 1. Exact match on the normalized name in the scope — ANY type. The
    // same name under a different type is almost always the same real-world
    // thing mis-typed by an extractor run; attaching to the existing node
    // (oldest wins, deterministically) beats minting a duplicate. Fixing a
    // genuinely wrong type is the hygiene merge's job, not the write path's.
    const exact = await this.repository.findByNormalizedName(
      normalizedName,
      null,
      scope
    );
    if (exact.isSome()) {
      const found = exact.unwrap();
      return Ok({
        entityId: found.id as EntityId,
        name: found.name,
        created: false,
      });
    }

    // 2. The same name spelled differently: lowercase, separator runs removed.
    // Type-agnostic like the exact probe — one subject written as a repo in
    // one memory and a project in another ("zero_memory" vs "zero-memory") is
    // the duplication this step exists to stop.
    const byMatchKey = await this.repository.findByMatchKey(
      entityMatchKey(displayName),
      null,
      scope
    );
    if (byMatchKey.isSome()) {
      const found = byMatchKey.unwrap();
      this.#logger.debug('entity resolved by match key', {
        name: displayName,
        matchedId: found.id,
        matchedName: found.name,
      });
      return Ok({
        entityId: found.id as EntityId,
        name: found.name,
        created: false,
      });
    }

    // 3. Neither probe knows this name: a genuinely new entity. The embedding
    // is computed HERE and not before, because only an insert needs it — the
    // two probes are exact, so a resolve that attaches costs no model call.
    //
    // Names are embedded as 'query' for both the stored name_embedding and
    // the topic matching in `build_context` that reads it, so the two sides
    // share one prefix and stay comparable. The choice is arbitrary — names
    // are short labels, not query/passage pairs — but it must be applied
    // consistently, and re-embedding (scripts/reembed.ts) matches it.
    const [nameEmbedding] = await this.embeddingService.embed(
      [normalizedName],
      'query'
    );
    if (!nameEmbedding) {
      return Err('Embedding service returned no vector for the entity name.');
    }

    const entityResult = Entity.create({
      name: displayName,
      type: fallbackType,
      scope,
    });
    if (entityResult.isErr()) {
      return Err(entityResult.unwrapErr());
    }
    const entity = entityResult.unwrap();

    const inserted = await this.repository.insert(entity, nameEmbedding);
    if (inserted.isErr()) {
      return Err(inserted.unwrapErr());
    }
    return Ok({ entityId: entity.id, name: entity.name, created: true });
  }
}
