import type { CloseLoopInput, MemoryId } from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Close an open loop (a task / open-question memory): invalidate it so it
 * drops out of every briefing's open_loops section while staying in history
 * (ADD-only). Props mirror `closeLoopInputSchema`.
 */
export class CloseLoopCommand extends Command implements CloseLoopInput {
  public readonly memory_id: MemoryId;

  constructor(props: CommandProps<CloseLoopInput>) {
    super(props);
    this.memory_id = props.memory_id;
  }
}
