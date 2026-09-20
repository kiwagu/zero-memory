import type {
  CardLogInput,
  CardNoteRelation,
  CardRefKind,
} from '@workspace/contracts';
import { Command, type CommandProps } from '@workspace/domain';

/**
 * Append to a card's stream: a note of your own, or an artifact the card
 * points at. Props mirror `cardLogInputSchema`.
 */
export class CardLogCommand extends Command implements CardLogInput {
  public readonly action: CardLogInput['action'];
  public readonly card_id: CardLogInput['card_id'];
  public readonly text?: string;
  public readonly reply_to?: CardLogInput['reply_to'];
  public readonly relation?: CardNoteRelation;
  public readonly ref_kind?: CardRefKind;
  public readonly ref_target?: string;
  public readonly thread?: string;
  public readonly agent_label?: string;
  public readonly idempotency_key?: string;

  constructor(props: CommandProps<CardLogInput>) {
    super(props);
    this.action = props.action;
    this.card_id = props.card_id;
    this.text = props.text;
    this.reply_to = props.reply_to;
    this.relation = props.relation;
    this.ref_kind = props.ref_kind;
    this.ref_target = props.ref_target;
    this.thread = props.thread;
    this.agent_label = props.agent_label;
    this.idempotency_key = props.idempotency_key;
  }
}
