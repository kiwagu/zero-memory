import { MoveMemoriesCommand } from '@workspace/commands';
import { FailureError, type MoveMemoriesOutput } from '@workspace/contracts';
import { commandHandler, type ICommandHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import { MemoryService } from '@workspace/memory';

@commandHandler(MoveMemoriesCommand)
@singleton()
export class MoveMemoriesCommandHandler implements ICommandHandler<
  MoveMemoriesCommand,
  MoveMemoriesOutput
> {
  // Explicit token: keeps DI working without emitted decorator metadata.
  constructor(@inject(MemoryService) private readonly service: MemoryService) {}

  async execute(command: MoveMemoriesCommand): Promise<MoveMemoriesOutput> {
    const result = await this.service.moveMemories(command);
    // `expect` would throw a plain Error and the boundary would report
    // `internal`; rethrowing the failure keeps the class the service set.
    if (result.isErr()) {
      throw new FailureError(result.unwrapErr());
    }
    return result.unwrap();
  }
}
