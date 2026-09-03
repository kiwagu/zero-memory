import { RememberCommand } from '@workspace/commands';
import { FailureError, type RememberOutput } from '@workspace/contracts';
import { commandHandler, type ICommandHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import { MemoryService } from '@workspace/memory';

@commandHandler(RememberCommand)
@singleton()
export class RememberCommandHandler implements ICommandHandler<
  RememberCommand,
  RememberOutput
> {
  // Explicit token: keeps DI working without emitted decorator metadata.
  constructor(@inject(MemoryService) private readonly service: MemoryService) {}

  async execute(command: RememberCommand): Promise<RememberOutput> {
    // Provenance is server-set: author_kind defaults to `agent` in the service;
    // agent_name carries the calling client (clientInfo.name) so the memory row
    // is attributable to the tool that wrote it.
    const result = await this.service.remember(command, {
      agentName: command.agentName ?? null,
    });
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
