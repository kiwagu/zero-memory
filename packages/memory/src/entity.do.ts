import {
  entityTypeSchema,
  newEntityId,
  type EntityId,
  type EntityType,
} from '@workspace/contracts';
import { Err, Ok, type Result } from 'oxide.ts';

import type { Scope } from './scope.vo.js';

/**
 * Display-name normalization: trim and collapse inner whitespace. The
 * lowercase `normalizedName` used for resolution is derived from this.
 */
export const normalizeEntityName = (raw: string): string =>
  raw.trim().replace(/\s+/g, ' ');

/**
 * Resolution key that sees past SPELLING and nothing else: lowercase with
 * every separator run removed, so `zero_memory`, `zero-memory`, `zero memory`
 * and `ZeroMemory` are one subject while `TICKET-4210` and `TICKET-4120` stay two.
 *
 * It replaces a cosine probe over name embeddings, which could not do this
 * job: measured on the live graph, the "same subject spelled differently" and
 * "distinct subjects" populations overlap so completely that the highest
 * similarity of all belonged to a DISTINCT pair (`resolve_conflict` against
 * `resolve_conflicts`), and no threshold separated them. This key does: over
 * every entity in the corpus it collides only on genuine spelling variants.
 *
 * Deliberately conservative. Morphological pairs (`embeddings`/`embedding`)
 * and synonyms (`PostgreSQL`/`Postgres`) are NOT one key and become separate
 * nodes — the same discipline the hygiene merge already applies to itself,
 * because a wrong merge is silent while fragmentation is visible and can be
 * repaired later.
 *
 * Unicode-aware: `\p{L}`-bearing names (this corpus is bilingual) keep their
 * letters, so only separators are stripped.
 */
export const entityMatchKey = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, '');

export interface EntityProps {
  name: string;
  type: EntityType;
  scope: Scope;
}

export interface CreateEntityInput {
  name: string;
  type?: string;
  scope: Scope;
  id?: EntityId;
}

/**
 * Knowledge-graph node of the memory context: a named thing (person,
 * project, tool, ...) that memories mention. Identity of a node inside a
 * scope is its (normalizedName, type) pair — enforced by the store.
 */
export class Entity {
  readonly id: EntityId;

  #props: EntityProps;

  private constructor(id: EntityId, props: EntityProps) {
    this.id = id;
    this.#props = props;
  }

  static create(input: CreateEntityInput): Result<Entity, string> {
    const name = normalizeEntityName(input.name);
    if (name.length === 0) {
      return Err('Entity name must not be empty.');
    }
    const parsedType = entityTypeSchema.safeParse(input.type ?? 'concept');
    if (!parsedType.success) {
      return Err(
        `Invalid entity type "${input.type}": expected one of ` +
          `${entityTypeSchema.options.join(', ')}.`
      );
    }
    return Ok(
      new Entity(input.id ?? newEntityId(), {
        name,
        type: parsedType.data,
        scope: input.scope,
      })
    );
  }

  /** Rebuilds a persisted entity (trusts the store's generated columns). */
  static reconstitute(id: EntityId, props: EntityProps): Entity {
    return new Entity(id, props);
  }

  get name(): string {
    return this.#props.name;
  }

  /** Resolution key: lowercase of the normalized display name. */
  get normalizedName(): string {
    return this.#props.name.toLowerCase();
  }

  get type(): EntityType {
    return this.#props.type;
  }

  get scope(): Scope {
    return this.#props.scope;
  }
}
