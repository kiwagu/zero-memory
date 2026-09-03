import { container, singleton, type DependencyContainer } from '@workspace/di';
import type { BaseEvent } from '@workspace/domain';

import {
  EVENT_HANDLER_METADATA,
  EVENT_METADATA,
  type HandlerTargetMetadata,
} from './decorators/constants.js';
import { InvalidEventHandlerException } from './exceptions.js';
import type { EventHandlerType, IEventBus, IEventHandler } from './types.js';

@singleton()
export class EventBus<
  TEvent extends BaseEvent = BaseEvent,
> implements IEventBus<TEvent> {
  #handlers = new Map<string, IEventHandler<TEvent>>();

  async publish(event: TEvent): Promise<void> {
    const eventId = this.getEventId(event);
    if (!eventId) {
      return;
    }
    const handler = this.#handlers.get(eventId);
    if (!handler) {
      return;
    }
    await handler.handle(event);
  }

  async publishMany(events: TEvent[]): Promise<void> {
    await Promise.all(events.map((event) => this.publish(event)));
  }

  register(
    handlers: EventHandlerType[] = [],
    c: DependencyContainer = container
  ): void {
    for (const handler of handlers) {
      this.registerHandler(c, handler);
    }
  }

  protected registerHandler(
    c: DependencyContainer,
    handler: EventHandlerType
  ): void {
    const instance = c.resolve(handler);
    if (!instance) {
      return;
    }
    const id = this.reflectEventId(handler);
    if (!id) {
      throw new InvalidEventHandlerException();
    }
    this.#handlers.set(id, instance as IEventHandler<TEvent>);
  }

  private reflectEventId(handler: EventHandlerType): string | undefined {
    const event = Reflect.getMetadata(EVENT_HANDLER_METADATA, handler) as
      object | undefined;
    if (!event) {
      return undefined;
    }
    const metadata = Reflect.getMetadata(EVENT_METADATA, event) as
      HandlerTargetMetadata | undefined;
    return metadata?.id;
  }

  private getEventId(event: TEvent): string | undefined {
    const { constructor: eventType } = Object.getPrototypeOf(event) as {
      constructor: object;
    };
    const metadata = Reflect.getMetadata(EVENT_METADATA, eventType) as
      HandlerTargetMetadata | undefined;
    return metadata?.id;
  }
}
