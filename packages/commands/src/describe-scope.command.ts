import type { DescribeScopeInput } from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Draft a short display description of one scope from a sample of its
 * memories (the model writes it) and store it as the scope's description
 * (source 'model'). Props mirror `describeScopeInputSchema`.
 */
export class DescribeScopeCommand
  extends Command
  implements DescribeScopeInput
{
  public readonly scope: string;

  constructor(props: CommandProps<DescribeScopeInput>) {
    super(props);
    this.scope = props.scope;
  }
}
