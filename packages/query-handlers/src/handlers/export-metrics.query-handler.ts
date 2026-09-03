import type { ExportMetricsOutput } from '@workspace/contracts';
import { queryHandler, type IQueryHandler } from '@workspace/cqrs';
import { singleton } from '@workspace/di';
import {
  injectExportMetricsReader,
  type IExportMetricsReader,
} from '@workspace/memory';
import { ExportMetricsQuery } from '@workspace/queries';

@queryHandler(ExportMetricsQuery)
@singleton()
export class ExportMetricsQueryHandler implements IQueryHandler<
  ExportMetricsQuery,
  ExportMetricsOutput
> {
  // Explicit token: keeps DI working without emitted decorator metadata.
  constructor(
    @injectExportMetricsReader()
    private readonly reader: IExportMetricsReader
  ) {}

  async execute(query: ExportMetricsQuery): Promise<ExportMetricsOutput> {
    return this.reader.read(query.days);
  }
}
