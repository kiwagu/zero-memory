import { ImportMemoryCommand } from '@workspace/commands';
import { FailureError, type ImportMemoryOutput } from '@workspace/contracts';
import { commandHandler, type ICommandHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import { ImportService } from '@workspace/extraction';

@commandHandler(ImportMemoryCommand)
@singleton()
export class ImportMemoryCommandHandler implements ICommandHandler<
  ImportMemoryCommand,
  ImportMemoryOutput
> {
  // Explicit token: keeps DI working without emitted decorator metadata.
  constructor(@inject(ImportService) private readonly service: ImportService) {}

  async execute(command: ImportMemoryCommand): Promise<ImportMemoryOutput> {
    const result = await this.service.import(command);
    if (result.isErr()) {
      // The service decided the failure class; rethrowing it keeps that
      // class instead of flattening every rejection into `internal`.
      throw new FailureError(result.unwrapErr());
    }
    return result.unwrap();
  }
}
