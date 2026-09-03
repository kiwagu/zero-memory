import { CloseLoopCommand } from '@workspace/commands';
import { FailureError, type CloseLoopOutput } from '@workspace/contracts';
import { commandHandler, type ICommandHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import { MemoryService } from '@workspace/memory';

@commandHandler(CloseLoopCommand)
@singleton()
export class CloseLoopCommandHandler implements ICommandHandler<
  CloseLoopCommand,
  CloseLoopOutput
> {
  // Explicit token: keeps DI working without emitted decorator metadata.
  constructor(@inject(MemoryService) private readonly service: MemoryService) {}

  async execute(command: CloseLoopCommand): Promise<CloseLoopOutput> {
    const result = await this.service.closeLoop(command);
    if (result.isErr()) {
      // Rethrow with the failure's own code so the boundary reports the
      // class the service decided — a caller-fixable rejection must not
      // arrive as `internal`. The message travels unchanged: it carries the
      // agent's course-correction.
      throw new FailureError(result.unwrapErr());
    }
    return result.unwrap();
  }
}
