import { container, singleton, type DependencyContainer } from '@workspace/di';
import type { Command } from '@workspace/domain';

import {
  COMMAND_HANDLER_METADATA,
  COMMAND_METADATA,
  type HandlerTargetMetadata,
} from './decorators/constants.js';
import {
  CommandHandlerNotFoundException,
  InvalidCommandHandlerException,
} from './exceptions.js';
import type {
  CommandHandlerType,
  ICommandBus,
  ICommandHandler,
} from './types.js';

@singleton()
export class CommandBus<C extends Command = Command> implements ICommandBus<C> {
  #handlers = new Map<string, ICommandHandler<C, unknown>>();

  async execute<T extends C, TResult = unknown>(command: T): Promise<TResult> {
    const handler = this.#handlers.get(this.getCommandId(command));
    if (!handler) {
      throw new CommandHandlerNotFoundException(this.getName(command));
    }
    return (await handler.execute(command)) as TResult;
  }

  register(
    handlers: CommandHandlerType[] = [],
    c: DependencyContainer = container
  ): void {
    for (const handler of handlers) {
      this.registerHandler(c, handler);
    }
  }

  protected registerHandler(
    c: DependencyContainer,
    handler: CommandHandlerType
  ): void {
    const instance = c.resolve(handler);
    if (!instance) {
      return;
    }
    const id = this.reflectCommandId(handler);
    if (!id) {
      throw new InvalidCommandHandlerException();
    }
    this.#handlers.set(id, instance as ICommandHandler<C, unknown>);
  }

  private reflectCommandId(handler: CommandHandlerType): string | undefined {
    const command = Reflect.getMetadata(COMMAND_HANDLER_METADATA, handler) as
      object | undefined;
    if (!command) {
      return undefined;
    }
    const metadata = Reflect.getMetadata(COMMAND_METADATA, command) as
      HandlerTargetMetadata | undefined;
    return metadata?.id;
  }

  private getCommandId(command: C): string {
    const { constructor: commandType } = Object.getPrototypeOf(command) as {
      constructor: object;
    };
    const metadata = Reflect.getMetadata(COMMAND_METADATA, commandType) as
      HandlerTargetMetadata | undefined;
    if (!metadata) {
      throw new CommandHandlerNotFoundException(this.getName(command));
    }
    return metadata.id;
  }

  private getName(command: C): string {
    const { constructor } = Object.getPrototypeOf(command) as {
      constructor: { name: string };
    };
    return constructor.name;
  }
}
