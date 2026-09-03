import type { ForgetInput, MemoryId } from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Invalidate (never delete) one memory. Props mirror `forgetInputSchema`.
 */
export class ForgetMemoryCommand extends Command implements ForgetInput {
  public readonly memory_id: MemoryId;
  public readonly reason?: string;

  constructor(props: CommandProps<ForgetInput>) {
    super(props);
    this.memory_id = props.memory_id;
    this.reason = props.reason;
  }
}
