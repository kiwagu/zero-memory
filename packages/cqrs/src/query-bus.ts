import { container, singleton, type DependencyContainer } from '@workspace/di';
import type { Query } from '@workspace/domain';

import {
  QUERY_HANDLER_METADATA,
  QUERY_METADATA,
  type HandlerTargetMetadata,
} from './decorators/constants.js';
import {
  InvalidQueryHandlerException,
  QueryHandlerNotFoundException,
} from './exceptions.js';
import type { IQueryBus, IQueryHandler, QueryHandlerType } from './types.js';

@singleton()
export class QueryBus<Q extends Query = Query> implements IQueryBus<Q> {
  #handlers = new Map<string, IQueryHandler<Q, unknown>>();

  async execute<T extends Q, TResult = unknown>(query: T): Promise<TResult> {
    const handler = this.#handlers.get(this.getQueryId(query));
    if (!handler) {
      throw new QueryHandlerNotFoundException(this.getName(query));
    }
    return (await handler.execute(query)) as TResult;
  }

  register(
    handlers: QueryHandlerType[] = [],
    c: DependencyContainer = container
  ): void {
    for (const handler of handlers) {
      this.registerHandler(c, handler);
    }
  }

  protected registerHandler(
    c: DependencyContainer,
    handler: QueryHandlerType
  ): void {
    const instance = c.resolve(handler);
    if (!instance) {
      return;
    }
    const id = this.reflectQueryId(handler);
    if (!id) {
      throw new InvalidQueryHandlerException();
    }
    this.#handlers.set(id, instance as IQueryHandler<Q, unknown>);
  }

  private reflectQueryId(handler: QueryHandlerType): string | undefined {
    const query = Reflect.getMetadata(QUERY_HANDLER_METADATA, handler) as
      object | undefined;
    if (!query) {
      return undefined;
    }
    const metadata = Reflect.getMetadata(QUERY_METADATA, query) as
      HandlerTargetMetadata | undefined;
    return metadata?.id;
  }

  private getQueryId(query: Q): string {
    const { constructor: queryType } = Object.getPrototypeOf(query) as {
      constructor: object;
    };
    const metadata = Reflect.getMetadata(QUERY_METADATA, queryType) as
      HandlerTargetMetadata | undefined;
    if (!metadata) {
      throw new QueryHandlerNotFoundException(this.getName(query));
    }
    return metadata.id;
  }

  private getName(query: Q): string {
    const { constructor } = Object.getPrototypeOf(query) as {
      constructor: { name: string };
    };
    return constructor.name;
  }
}
