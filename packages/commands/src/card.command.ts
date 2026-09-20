import type { CardInput, CardState, MemoryId } from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Open a card, promote a loop into one, rewrite its text, declare where the
 * work stands, or take it off the board. Props mirror `cardInputSchema`.
 *
 * One command for five verbs because they share a subject and a guard: each
 * writes the card and its stream in the same breath, and a move or an archive
 * is refused without a reason.
 */
export class CardCommand extends Command implements CardInput {
  public readonly action: CardInput['action'];
  public readonly card_id?: CardInput['card_id'];
  public readonly scope?: string;
  public readonly loop_id?: MemoryId;
  public readonly title?: string;
  public readonly body?: string;
  public readonly state?: CardState;
  public readonly to?: CardState;
  public readonly reason?: string;
  public readonly expected_revision?: number;
  public readonly thread?: string;
  public readonly agent_label?: string;
  public readonly idempotency_key?: string;

  constructor(props: CommandProps<CardInput>) {
    super(props);
    this.action = props.action;
    this.card_id = props.card_id;
    this.scope = props.scope;
    this.loop_id = props.loop_id;
    this.title = props.title;
    this.body = props.body;
    this.state = props.state;
    this.to = props.to;
    this.reason = props.reason;
    this.expected_revision = props.expected_revision;
    this.thread = props.thread;
    this.agent_label = props.agent_label;
    this.idempotency_key = props.idempotency_key;
  }
}
