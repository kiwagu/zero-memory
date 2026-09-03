import type { LinkInput, LinkType } from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Connect two entities (by name) or two memories (by uuid). Props mirror
 * the `linkInputSchema` contract.
 */
export class LinkCommand extends Command implements LinkInput {
  public readonly src: string;
  public readonly dst: string;
  public readonly type: LinkType;

  constructor(props: CommandProps<LinkInput>) {
    super(props);
    this.src = props.src;
    this.dst = props.dst;
    this.type = props.type;
  }
}
