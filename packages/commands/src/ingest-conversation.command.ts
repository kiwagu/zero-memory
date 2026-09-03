import type {
  IngestConversationInput,
  IngestSourceKind,
} from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Feed one transcript chunk into the auto-population pipeline. Props mirror
 * the `ingestConversationInputSchema` contract.
 */
export class IngestConversationCommand
  extends Command
  implements IngestConversationInput
{
  public readonly transcript_chunk: string;
  public readonly chunk_hash: string;
  public readonly client: string;
  public readonly conversation_id: string;
  public readonly project_hint?: string;
  public readonly recalled_ids?: string[];
  public readonly source_kind?: IngestSourceKind;
  public readonly source_path?: string;
  public readonly probe?: boolean;

  constructor(props: CommandProps<IngestConversationInput>) {
    super(props);
    this.transcript_chunk = props.transcript_chunk;
    this.chunk_hash = props.chunk_hash;
    this.client = props.client;
    this.conversation_id = props.conversation_id;
    this.project_hint = props.project_hint;
    this.recalled_ids = props.recalled_ids;
    this.source_kind = props.source_kind;
    this.source_path = props.source_path;
    this.probe = props.probe;
  }
}
