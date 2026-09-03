import { ExportMemoriesCommand } from '@workspace/commands';
import type { ExportMemoriesOutput } from '@workspace/contracts';
import { commandHandler, type ICommandHandler } from '@workspace/cqrs';
import { singleton } from '@workspace/di';
import {
  injectMemoryExportReader,
  type IMemoryExportReader,
} from '@workspace/memory';

@commandHandler(ExportMemoriesCommand)
@singleton()
export class ExportMemoriesCommandHandler implements ICommandHandler<
  ExportMemoriesCommand,
  ExportMemoriesOutput
> {
  // Reads through the export port directly: no domain logic, just an
  // RLS-scoped bulk read whose value is the audited command wrapper.
  constructor(
    @injectMemoryExportReader()
    private readonly reader: IMemoryExportReader
  ) {}

  async execute(command: ExportMemoriesCommand): Promise<ExportMemoriesOutput> {
    const items = await this.reader.listAll(command.scopes);
    return { items, count: items.length };
  }
}
