import { ForgetMemoryCommand } from '@workspace/commands';
import { FailureError, type ForgetOutput } from '@workspace/contracts';
import { commandHandler, type ICommandHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import { MemoryService } from '@workspace/memory';

@commandHandler(ForgetMemoryCommand)
@singleton()
export class ForgetMemoryCommandHandler implements ICommandHandler<
  ForgetMemoryCommand,
  ForgetOutput
> {
  // Explicit token: keeps DI working without emitted decorator metadata.
  constructor(@inject(MemoryService) private readonly service: MemoryService) {}

  async execute(command: ForgetMemoryCommand): Promise<ForgetOutput> {
    const result = await this.service.forget(command);
    // `expect` would throw a plain Error and the boundary would report
    // `internal`; rethrowing the failure keeps the class the service set.
    if (result.isErr()) {
      throw new FailureError(result.unwrapErr());
    }
    return result.unwrap();
  }
}
