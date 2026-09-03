import { FailureError, type RecallOutput } from '@workspace/contracts';
import { queryHandler, type IQueryHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import { MemoryService } from '@workspace/memory';
import { RecallQuery } from '@workspace/queries';

@queryHandler(RecallQuery)
@singleton()
export class RecallQueryHandler implements IQueryHandler<
  RecallQuery,
  RecallOutput
> {
  // Explicit token: keeps DI working without emitted decorator metadata.
  constructor(@inject(MemoryService) private readonly service: MemoryService) {}

  async execute(query: RecallQuery): Promise<RecallOutput> {
    const result = await this.service.recall(query);
    if (result.isErr()) {
      throw new FailureError(result.unwrapErr());
    }
    return result.unwrap();
  }
}
