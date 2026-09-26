import type { ReleaseInput } from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Read or set where a project's production lives, list what a production
 * state could carry, or record the state and the cards it carries. Props
 * mirror `releaseInputSchema`.
 */
export class ReleaseCommand extends Command implements ReleaseInput {
  public readonly action: ReleaseInput['action'];
  public readonly scope: string;
  public readonly version_url?: string | null;
  public readonly version_field?: string;
  public readonly tag_template?: string;
  public readonly tag_pattern?: string;
  public readonly on_release?: ReleaseInput['on_release'];
  public readonly version?: string;
  public readonly build?: string | null;
  public readonly release_commit?: string;
  public readonly source?: ReleaseInput['source'];
  public readonly card_ids?: ReleaseInput['card_ids'];
  public readonly landing_seqs?: number[];
  public readonly thread?: string;
  public readonly agent_label?: string;

  constructor(props: CommandProps<ReleaseInput>) {
    super(props);
    this.action = props.action;
    this.scope = props.scope;
    this.version_url = props.version_url;
    this.version_field = props.version_field;
    this.tag_template = props.tag_template;
    this.tag_pattern = props.tag_pattern;
    this.on_release = props.on_release;
    this.version = props.version;
    this.build = props.build;
    this.release_commit = props.release_commit;
    this.source = props.source;
    this.card_ids = props.card_ids;
    this.landing_seqs = props.landing_seqs;
    this.thread = props.thread;
    this.agent_label = props.agent_label;
  }
}
