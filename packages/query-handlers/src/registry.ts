import { QueryBus } from '@workspace/cqrs';
import { container, type DependencyContainer } from '@workspace/di';

import { queryHandlers } from './handlers/index.js';

export const registerQueries = (c: DependencyContainer = container): void => {
  const queryBus = c.resolve(QueryBus);
  queryBus.register(queryHandlers, c);
};
