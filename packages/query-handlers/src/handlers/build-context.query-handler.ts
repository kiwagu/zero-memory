import { FailureError, type BuildContextOutput } from '@workspace/contracts';
import { queryHandler, type IQueryHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import { MemoryService } from '@workspace/memory';
import { BuildContextQuery } from '@workspace/queries';

@queryHandler(BuildContextQuery)
@singleton()
export class BuildContextQueryHandler implements IQueryHandler<
  BuildContextQuery,
  BuildContextOutput
> {
  // Explicit token: keeps DI working without emitted decorator metadata.
  constructor(@inject(MemoryService) private readonly service: MemoryService) {}

  async execute(query: BuildContextQuery): Promise<BuildContextOutput> {
    const result = await this.service.buildContext(query);
    if (result.isErr()) {
      throw new FailureError(result.unwrapErr());
    }
    return result.unwrap();
  }
}
