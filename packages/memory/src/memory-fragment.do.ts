import { newMemoryId, type MemoryId, type UserId } from '@workspace/contracts';
import { AggregateRoot } from '@workspace/domain';
import { Err, Ok, type Result } from 'oxide.ts';

import { Lifecycle } from './lifecycle.vo.js';
import type { MemoryContent } from './memory-content.vo.js';
import {
  MemoryInvalidatedEvent,
  MemoryRememberedEvent,
  MemorySharedEvent,
  type MemoryDomainEvent,
} from './memory.events.js';
import type { Provenance } from './provenance.vo.js';
import type { Scope } from './scope.vo.js';
import { TranslationState } from './translation-state.vo.js';
import { Visibility } from './visibility.vo.js';

export interface MemoryFragmentProps {
  content: MemoryContent;
  scope: Scope;
  visibility: Visibility;
  provenance: Provenance;
  lifecycle: Lifecycle;
  translation: TranslationState;
}

export interface CreateMemoryFragmentInput {
  content: MemoryContent;
  scope: Scope;
  provenance: Provenance;
  visibility?: Visibility;
  /** Language-canonicalization state; defaults to already-English (skipped). */
  translation?: TranslationState;
  id?: MemoryId;
  now?: Date;
}

/**
 * Aggregate root of the memory context: one remembered fragment.
 *
 * ADD-only semantics: a fragment is never deleted. `invalidate` closes it,
 * `supersede` closes it while pointing at its replacement.
 */
export class MemoryFragment extends AggregateRoot<MemoryDomainEvent> {
  readonly id: MemoryId;

  #props: MemoryFragmentProps;

  private constructor(id: MemoryId, props: MemoryFragmentProps) {
    super();
    this.id = id;
    this.#props = props;
  }

  static create(
    input: CreateMemoryFragmentInput
  ): Result<MemoryFragment, string> {
    const visibility = input.visibility ?? Visibility.private();
    const fragment = new MemoryFragment(input.id ?? newMemoryId(), {
      content: input.content,
      scope: input.scope,
      visibility,
      provenance: input.provenance,
      lifecycle: Lifecycle.start(input.now),
      translation: input.translation ?? TranslationState.skipped(),
    });
    fragment.addDomainEvent(
      new MemoryRememberedEvent({
        memoryId: fragment.id,
        scope: input.scope.path,
        kind: input.content.kind,
        visibility: visibility.level,
        ownerId: input.provenance.ownerId,
      })
    );
    return Ok(fragment);
  }

  /** Rebuilds a persisted fragment without raising domain events. */
  static reconstitute(
    id: MemoryId,
    props: MemoryFragmentProps
  ): MemoryFragment {
    return new MemoryFragment(id, props);
  }

  get content(): MemoryContent {
    return this.#props.content;
  }

  get scope(): Scope {
    return this.#props.scope;
  }

  get visibility(): Visibility {
    return this.#props.visibility;
  }

  get provenance(): Provenance {
    return this.#props.provenance;
  }

  get lifecycle(): Lifecycle {
    return this.#props.lifecycle;
  }

  get translation(): TranslationState {
    return this.#props.translation;
  }

  /**
   * Widens the fragment to a shared scope. Only the owner may share, and only
   * while the fragment is still valid. Re-sharing to the same scope is a
   * no-op; a shared fragment can be moved to another scope by its owner.
   */
  share(
    targetScope: Scope,
    byUserId: UserId,
    now: Date = new Date()
  ): Result<void, string> {
    if (this.#props.provenance.ownerId !== byUserId) {
      return Err(`Only the owner may share memory ${this.id}.`);
    }
    if (this.#props.lifecycle.isInvalidated) {
      return Err(`Memory ${this.id} is invalidated and cannot be shared.`);
    }
    if (
      this.#props.visibility.isShared &&
      this.#props.scope.path === targetScope.path
    ) {
      return Ok(undefined);
    }
    this.#props = {
      ...this.#props,
      scope: targetScope,
      visibility: Visibility.shared(),
      lifecycle: this.#props.lifecycle.shared(byUserId, now),
    };
    this.addDomainEvent(
      new MemorySharedEvent({
        memoryId: this.id,
        scope: targetScope.path,
        sharedBy: byUserId,
      })
    );
    return Ok(undefined);
  }

  /** Closes the fragment; ADD-only replacement for deletion. */
  invalidate(byUserId: UserId, now: Date = new Date()): Result<void, string> {
    if (this.#props.lifecycle.isInvalidated) {
      return Err(`Memory ${this.id} is already invalidated.`);
    }
    this.#props = {
      ...this.#props,
      lifecycle: this.#props.lifecycle.invalidated(byUserId, now),
    };
    this.addDomainEvent(
      new MemoryInvalidatedEvent({
        memoryId: this.id,
        invalidatedBy: byUserId,
        supersededBy: null,
      })
    );
    return Ok(undefined);
  }

  /** Closes the fragment and points at the memory that replaces it. */
  supersede(
    successorId: MemoryId,
    byUserId: UserId,
    now: Date = new Date()
  ): Result<void, string> {
    if (successorId === this.id) {
      return Err('A memory cannot supersede itself.');
    }
    if (this.#props.lifecycle.isInvalidated) {
      return Err(`Memory ${this.id} is already invalidated.`);
    }
    this.#props = {
      ...this.#props,
      lifecycle: this.#props.lifecycle.superseded(successorId, byUserId, now),
    };
    this.addDomainEvent(
      new MemoryInvalidatedEvent({
        memoryId: this.id,
        invalidatedBy: byUserId,
        supersededBy: successorId,
      })
    );
    return Ok(undefined);
  }
}
