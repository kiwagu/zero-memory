import type { ExportMemoriesInput } from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Export every memory the caller can access as flat rows (no LLM, no writes).
 * Modeled as a command — despite being a read — so the audited command bus
 * records the bulk egress in `audit_log`. Props mirror `exportMemoriesInputSchema`.
 */
export class ExportMemoriesCommand
  extends Command
  implements ExportMemoriesInput
{
  public readonly scopes?: string[];

  constructor(props: CommandProps<ExportMemoriesInput> = {}) {
    super(props);
    this.scopes = props.scopes;
  }
}
