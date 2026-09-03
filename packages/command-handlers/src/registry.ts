import { CommandBus } from '@workspace/cqrs';
import { container, type DependencyContainer } from '@workspace/di';

import { commandHandlers } from './handlers/index.js';

export const registerCommands = (c: DependencyContainer = container): void => {
  const commandBus = c.resolve(CommandBus);
  commandBus.register(commandHandlers, c);
};
