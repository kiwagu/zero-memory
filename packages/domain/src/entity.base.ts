import type { ID } from './id.vo.js';

export interface BaseEntityProps<TId extends ID> {
  id: TId;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEntityProps<TId extends ID, TProps> {
  id: TId;
  props: TProps;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Base entity: identity-compared, holds its own props plus audit timestamps.
 */
export abstract class Entity<TId extends ID, TProps = unknown> {
  protected readonly props: TProps;

  private readonly _id: TId;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  constructor({
    id,
    props,
    createdAt,
    updatedAt,
  }: CreateEntityProps<TId, TProps>) {
    const now = new Date();
    this._id = id;
    this._createdAt = createdAt ?? now;
    this._updatedAt = updatedAt ?? now;
    this.props = props;
  }

  get id(): TId {
    return this._id;
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  protected touch(): void {
    this._updatedAt = new Date();
  }

  /**
   * Entities are equal when their ids are equal.
   */
  equals(other?: Entity<TId, TProps>): boolean {
    if (other === null || other === undefined) {
      return false;
    }
    if (this === other) {
      return true;
    }
    return this.id.equals(other.id);
  }

  /**
   * Returns a frozen copy of the entity's props (no live references).
   */
  getPropsCopy(): TProps & BaseEntityProps<TId> {
    return Object.freeze({
      id: this._id,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
      ...this.props,
    });
  }
}
