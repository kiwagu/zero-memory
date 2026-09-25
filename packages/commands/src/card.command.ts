import type {
  CardBranch,
  CardInput,
  CardLinkInput,
  CardLinkRelation,
  CardState,
  MemoryId,
} from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Open a card, promote a loop into one, rewrite its text, declare where the
 * work stands, take it off the board, record that its branch landed, or
 * relate it to another card. Props mirror `cardInputSchema`.
 *
 * One command for these verbs because they share a subject and a guard: each
 * writes the card and its stream in the same breath, and a move, an archive,
 * a landing or a relation is refused without a reason.
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
  public readonly branch?: CardBranch;
  public readonly no_branch?: string;
  public readonly not_landed?: string;
  public readonly squash_sha?: string;
  public readonly target?: string;
  public readonly to_card?: string;
  public readonly relation?: CardLinkRelation;
  public readonly links?: CardLinkInput[];
  public readonly no_links?: string;
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
    this.branch = props.branch;
    this.no_branch = props.no_branch;
    this.not_landed = props.not_landed;
    this.squash_sha = props.squash_sha;
    this.target = props.target;
    this.to_card = props.to_card;
    this.relation = props.relation;
    this.links = props.links;
    this.no_links = props.no_links;
    this.thread = props.thread;
    this.agent_label = props.agent_label;
    this.idempotency_key = props.idempotency_key;
  }
}
