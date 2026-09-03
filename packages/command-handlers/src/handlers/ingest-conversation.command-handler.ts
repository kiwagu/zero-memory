import { IngestConversationCommand } from '@workspace/commands';
import {
  FailureError,
  type IngestConversationOutput,
} from '@workspace/contracts';
import { commandHandler, type ICommandHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import { IngestService } from '@workspace/extraction';

@commandHandler(IngestConversationCommand)
@singleton()
export class IngestConversationCommandHandler implements ICommandHandler<
  IngestConversationCommand,
  IngestConversationOutput
> {
  // Explicit token: keeps DI working without emitted decorator metadata.
  constructor(@inject(IngestService) private readonly service: IngestService) {}

  async execute(
    command: IngestConversationCommand
  ): Promise<IngestConversationOutput> {
    const result = await this.service.ingest(command);
    if (result.isErr()) {
      // Surface the actual cause: a generic message repeatedly cost debugging
      // time (the real Err was swallowed) and hides retryable API failures.
      // The service decided the failure class; rethrowing it keeps that
      // class instead of flattening every rejection into `internal`.
      throw new FailureError(result.unwrapErr());
    }
    return result.unwrap();
  }
}
