import { DescribeScopeCommand } from '@workspace/commands';
import { FailureError, type DescribeScopeOutput } from '@workspace/contracts';
import { commandHandler, type ICommandHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import { ScopeDescribeService } from '@workspace/extraction';

@commandHandler(DescribeScopeCommand)
@singleton()
export class DescribeScopeCommandHandler implements ICommandHandler<
  DescribeScopeCommand,
  DescribeScopeOutput
> {
  // Explicit token: keeps DI working without emitted decorator metadata.
  constructor(
    @inject(ScopeDescribeService)
    private readonly service: ScopeDescribeService
  ) {}

  async execute(command: DescribeScopeCommand): Promise<DescribeScopeOutput> {
    const result = await this.service.describe(command);
    if (result.isErr()) {
      // The service decided the failure class; rethrowing it keeps that
      // class instead of flattening every rejection into `internal`.
      throw new FailureError(result.unwrapErr());
    }
    return result.unwrap();
  }
}
