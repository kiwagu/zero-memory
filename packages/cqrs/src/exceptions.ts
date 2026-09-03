import { ExceptionBase } from '@workspace/domain';

export class CommandHandlerNotFoundException extends ExceptionBase {
  code = 'CQRS.COMMAND_HANDLER_NOT_FOUND';

  constructor(commandName: string) {
    super(`No handler registered for command "${commandName}".`);
  }
}

export class InvalidCommandHandlerException extends ExceptionBase {
  code = 'CQRS.INVALID_COMMAND_HANDLER';

  constructor() {
    super('Command handler is missing @commandHandler metadata.');
  }
}

export class QueryHandlerNotFoundException extends ExceptionBase {
  code = 'CQRS.QUERY_HANDLER_NOT_FOUND';

  constructor(queryName: string) {
    super(`No handler registered for query "${queryName}".`);
  }
}

export class InvalidQueryHandlerException extends ExceptionBase {
  code = 'CQRS.INVALID_QUERY_HANDLER';

  constructor() {
    super('Query handler is missing @queryHandler metadata.');
  }
}

export class InvalidEventHandlerException extends ExceptionBase {
  code = 'CQRS.INVALID_EVENT_HANDLER';

  constructor() {
    super('Event handler is missing @eventHandler metadata.');
  }
}
