import type {
  EntityMention,
  MemoryKind,
  MemoryLink,
  RememberInput,
} from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Store one memory. Props mirror the `rememberInputSchema` contract.
 */
export class RememberCommand extends Command implements RememberInput {
  public readonly content: string;
  public readonly kind?: MemoryKind;
  public readonly scope?: string;
  public readonly project_hint?: string;
  public readonly entities?: EntityMention[];
  public readonly links?: MemoryLink[];
  public readonly verbatim?: string;
  /**
   * The thread token, when the caller presented one. It is how a reconnected
   * session still knows where its work belongs — without it a write that
   * names no scope would be refused although the project is well known.
   */
  public readonly thread?: string;
  /**
   * The calling MCP client's self-declared name (clientInfo.name from the
   * initialize handshake), stamped onto the memory's provenance so a direct
   * agent write is attributable to the tool that made it (Claude Code, Cursor,
   * Codex, …). Server-set, never from the tool input. Null when the client did
   * not declare a name.
   */
  public readonly agentName?: string | null;

  constructor(props: CommandProps<RememberInput>, agentName?: string | null) {
    super(props);
    this.content = props.content;
    this.kind = props.kind;
    this.scope = props.scope;
    this.project_hint = props.project_hint;
    this.entities = props.entities;
    this.links = props.links;
    this.verbatim = props.verbatim;
    this.thread = props.thread;
    this.agentName = agentName;
  }
}
