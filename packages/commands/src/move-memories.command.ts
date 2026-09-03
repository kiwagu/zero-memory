import type { MemoryId, MoveMemoriesInput } from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Batch-move memories into a project scope — the standing migration primitive
 * for mis-routed memories. Props mirror `moveMemoriesInputSchema`.
 */
export class MoveMemoriesCommand extends Command implements MoveMemoriesInput {
  public readonly memory_ids: MemoryId[];
  public readonly scope?: string;
  public readonly project_hint?: string;

  constructor(props: CommandProps<MoveMemoriesInput>) {
    super(props);
    this.memory_ids = props.memory_ids;
    this.scope = props.scope;
    this.project_hint = props.project_hint;
  }
}
