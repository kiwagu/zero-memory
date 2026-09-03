import { LinkCommand } from '@workspace/commands';
import { FailureError, type LinkOutput } from '@workspace/contracts';
import { commandHandler, type ICommandHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import { MemoryService } from '@workspace/memory';

@commandHandler(LinkCommand)
@singleton()
export class LinkCommandHandler implements ICommandHandler<
  LinkCommand,
  LinkOutput
> {
  // Explicit token: keeps DI working without emitted decorator metadata.
  constructor(@inject(MemoryService) private readonly service: MemoryService) {}

  async execute(command: LinkCommand): Promise<LinkOutput> {
    const result = await this.service.link(command);
    // `expect` would throw a plain Error and the boundary would report
    // `internal`; rethrowing the failure keeps the class the service set.
    if (result.isErr()) {
      throw new FailureError(result.unwrapErr());
    }
    return result.unwrap();
  }
}
