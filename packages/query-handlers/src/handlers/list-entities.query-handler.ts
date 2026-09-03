import { FailureError, type EntitiesOutput } from '@workspace/contracts';
import { queryHandler, type IQueryHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import { MemoryService } from '@workspace/memory';
import { ListEntitiesQuery } from '@workspace/queries';

@queryHandler(ListEntitiesQuery)
@singleton()
export class ListEntitiesQueryHandler implements IQueryHandler<
  ListEntitiesQuery,
  EntitiesOutput
> {
  // Explicit token: keeps DI working without emitted decorator metadata.
  constructor(@inject(MemoryService) private readonly service: MemoryService) {}

  async execute(query: ListEntitiesQuery): Promise<EntitiesOutput> {
    const result = await this.service.listEntities(query);
    if (result.isErr()) {
      throw new FailureError(result.unwrapErr());
    }
    return result.unwrap();
  }
}
