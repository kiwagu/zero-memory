import type { ExportedMemory } from '@workspace/contracts';
import { queryHandler, type IQueryHandler } from '@workspace/cqrs';
import { singleton } from '@workspace/di';
import {
  injectMemoryExportReader,
  type IMemoryExportReader,
} from '@workspace/memory';
import { GetMemoryQuery } from '@workspace/queries';

@queryHandler(GetMemoryQuery)
@singleton()
export class GetMemoryQueryHandler implements IQueryHandler<
  GetMemoryQuery,
  ExportedMemory | null
> {
  // Reads through the export port: the resource wants the flat full-fidelity
  // row (untruncated content, lifecycle fields), not a domain aggregate.
  constructor(
    @injectMemoryExportReader()
    private readonly reader: IMemoryExportReader
  ) {}

  async execute(query: GetMemoryQuery): Promise<ExportedMemory | null> {
    return this.reader.findById(query.memoryId);
  }
}
