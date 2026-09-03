import type { BaseEvent } from './event.js';

/**
 * Aggregate root: collects domain events raised by state changes until a
 * publisher drains them.
 */
export abstract class AggregateRoot<TEvent extends BaseEvent> {
  #domainEvents: TEvent[] = [];

  get domainEvents(): TEvent[] {
    return this.#domainEvents;
  }

  set domainEvents(events: TEvent[]) {
    this.#domainEvents = events;
  }

  protected addDomainEvent(event: TEvent): void {
    this.#domainEvents.push(event);
  }

  removeEvents(events: TEvent[]): void {
    this.#domainEvents = this.#domainEvents.filter(
      (event) => !events.includes(event)
    );
  }

  clearEvents(): void {
    this.#domainEvents = [];
  }
}
