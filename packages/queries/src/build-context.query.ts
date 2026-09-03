import type { BuildContextInput } from '@workspace/contracts';
import { Query, type QueryProps } from '@workspace/domain';

/**
 * One-call context briefing for a topic (session-start unfold). Props
 * mirror the `buildContextInputSchema` contract.
 */
export class BuildContextQuery extends Query implements BuildContextInput {
  public readonly topic: string;
  public readonly max_tokens?: number;
  public readonly scopes?: string[];
  public readonly briefing?: boolean;
  public readonly project_hint?: string;
  /**
   * Conversation identity and its thread token. Both are load-bearing rather
   * than metadata: the conversation id is what a briefing ASSERTS the thread
   * against, and the token is what a reconnected session presents to get its
   * project back. Dropping them here silently disabled both — the query
   * object is the contract's real boundary, not the schema alone.
   */
  public readonly conversation_id?: string;
  public readonly thread?: string;
  public readonly briefing_kind?: 'session' | 'task';

  constructor(props: QueryProps<BuildContextInput>) {
    super();
    this.topic = props.topic;
    this.max_tokens = props.max_tokens;
    this.scopes = props.scopes;
    this.briefing = props.briefing;
    this.project_hint = props.project_hint;
    this.conversation_id = props.conversation_id;
    this.thread = props.thread;
    this.briefing_kind = props.briefing_kind;
  }
}
