import type { MemoryId, UserId } from '@workspace/contracts';
import { ValueObject } from '@workspace/domain';

export interface LifecycleProps {
  validFrom: Date;
  createdAt: Date;
  invalidatedAt: Date | null;
  invalidatedBy: UserId | null;
  supersededBy: MemoryId | null;
  sharedAt: Date | null;
  sharedBy: UserId | null;
}

/**
 * ADD-only lifecycle of a memory: it is never deleted, only invalidated
 * (optionally superseded by a newer memory) or shared. Immutable — state
 * changes return a new Lifecycle.
 */
export class Lifecycle extends ValueObject<LifecycleProps> {
  static start(now: Date = new Date()): Lifecycle {
    return new Lifecycle({
      validFrom: now,
      createdAt: now,
      invalidatedAt: null,
      invalidatedBy: null,
      supersededBy: null,
      sharedAt: null,
      sharedBy: null,
    });
  }

  static restore(props: LifecycleProps): Lifecycle {
    return new Lifecycle({ ...props });
  }

  get isInvalidated(): boolean {
    return this.props.invalidatedAt !== null;
  }

  get validFrom(): Date {
    return this.props.validFrom;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get invalidatedAt(): Date | null {
    return this.props.invalidatedAt;
  }

  get invalidatedBy(): UserId | null {
    return this.props.invalidatedBy;
  }

  get supersededBy(): MemoryId | null {
    return this.props.supersededBy;
  }

  get sharedAt(): Date | null {
    return this.props.sharedAt;
  }

  get sharedBy(): UserId | null {
    return this.props.sharedBy;
  }

  invalidated(byUserId: UserId, at: Date = new Date()): Lifecycle {
    return new Lifecycle({
      ...this.props,
      invalidatedAt: at,
      invalidatedBy: byUserId,
    });
  }

  superseded(
    successorId: MemoryId,
    byUserId: UserId,
    at: Date = new Date()
  ): Lifecycle {
    return new Lifecycle({
      ...this.props,
      invalidatedAt: at,
      invalidatedBy: byUserId,
      supersededBy: successorId,
    });
  }

  shared(byUserId: UserId, at: Date = new Date()): Lifecycle {
    return new Lifecycle({
      ...this.props,
      sharedAt: at,
      sharedBy: byUserId,
    });
  }
}
