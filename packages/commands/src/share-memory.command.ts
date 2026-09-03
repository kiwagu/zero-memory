import type { ShareInput, MemoryId } from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Widen one memory to a shared scope. Props mirror `shareInputSchema`.
 */
export class ShareMemoryCommand extends Command implements ShareInput {
  public readonly memory_id: MemoryId;
  public readonly scope: string;

  constructor(props: CommandProps<ShareInput>) {
    super(props);
    this.memory_id = props.memory_id;
    this.scope = props.scope;
  }
}
