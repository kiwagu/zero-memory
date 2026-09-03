import type { BaseEvent, Command, Query } from '@workspace/domain';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Class<T> = new (...args: any[]) => T;

export interface ICommandHandler<
  TCommand extends Command = Command,
  TResult = unknown,
> {
  execute(command: TCommand): Promise<TResult>;
}

export interface IQueryHandler<
  TQuery extends Query = Query,
  TResult = unknown,
> {
  execute(query: TQuery): Promise<TResult>;
}

export interface IEventHandler<TEvent extends BaseEvent = BaseEvent> {
  handle(event: TEvent): Promise<void>;
}

export interface ICommandBus<TCommand extends Command = Command> {
  execute<T extends TCommand, TResult = unknown>(command: T): Promise<TResult>;
}

export interface IQueryBus<TQuery extends Query = Query> {
  execute<T extends TQuery, TResult = unknown>(query: T): Promise<TResult>;
}

export interface IEventBus<TEvent extends BaseEvent = BaseEvent> {
  publish(event: TEvent): Promise<void>;
  publishMany(events: TEvent[]): Promise<void>;
}

export type CommandHandlerType = Class<ICommandHandler>;
export type QueryHandlerType = Class<IQueryHandler>;
export type EventHandlerType = Class<IEventHandler>;
