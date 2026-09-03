import { nanoid } from 'nanoid';

export interface IEvent<TPayload extends object = object, TMeta = unknown> {
  id: string;
  name: string;
  operatorId?: string;
  payload: TPayload;
  meta: TMeta;
  timestamp: Date;
}

export interface IEventJSON<TPayload extends object = object, TMeta = unknown> {
  id: string;
  name: string;
  operatorId?: string;
  payload: TPayload;
  meta: TMeta;
  timestamp: string;
}

/**
 * Base domain event. Concrete events pin `name` to a literal type.
 */
export abstract class BaseEvent<
  TPayload extends object = object,
  TName extends string = string,
  TMeta = unknown,
> implements IEvent<TPayload, TMeta> {
  abstract readonly name: TName;

  #operatorId?: string;

  constructor(
    public readonly payload: TPayload,
    public readonly meta: TMeta,
    public readonly id = nanoid(),
    public readonly timestamp = new Date()
  ) {}

  get operatorId(): string | undefined {
    return this.#operatorId;
  }

  set operatorId(operatorId: string | undefined) {
    this.#operatorId = operatorId;
  }

  toJSON(): IEventJSON<TPayload, TMeta> {
    return {
      id: this.id,
      name: this.name,
      operatorId: this.operatorId,
      payload: this.payload,
      meta: this.meta,
      timestamp: this.timestamp.toISOString(),
    };
  }
}
