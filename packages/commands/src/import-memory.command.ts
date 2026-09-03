import type {
  ImportMemoryInput,
  ImportMemoryTarget,
  MemoryKind,
} from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Import one already-atomic native memory deterministically (no LLM). Props
 * mirror the `importMemoryInputSchema` contract.
 */
export class ImportMemoryCommand extends Command implements ImportMemoryInput {
  public readonly content: string;
  public readonly kind: MemoryKind;
  public readonly target: ImportMemoryTarget;
  public readonly project_hint?: string;
  public readonly source_tool?: string;
  public readonly source_path: string;
  public readonly source_hash: string;
  public readonly verbatim?: string;

  constructor(props: CommandProps<ImportMemoryInput>) {
    super(props);
    this.content = props.content;
    this.kind = props.kind;
    this.target = props.target;
    this.project_hint = props.project_hint;
    this.source_tool = props.source_tool;
    this.source_path = props.source_path;
    this.source_hash = props.source_hash;
    this.verbatim = props.verbatim;
  }
}
