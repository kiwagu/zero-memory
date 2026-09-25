import type { BoardInput, CardState } from '@workspace/contracts';
import { Query, type QueryProps } from '@workspace/domain';

/**
 * Read the board: a scope's cards (or those related to one card), one card
 * with its history, feed and relations, or the card a project-local number
 * points at. Props mirror `boardInputSchema`.
 */
export class BoardQuery extends Query implements BoardInput {
  public readonly action: BoardInput['action'];
  public readonly scope?: string;
  public readonly state?: CardState;
  public readonly query?: string;
  public readonly include_archived?: boolean;
  public readonly card_id?: BoardInput['card_id'];
  public readonly number?: number;
  public readonly after_seq?: number;
  public readonly feed_before?: BoardInput['feed_before'];
  public readonly limit?: number;
  public readonly related_to?: string;
  public readonly relation_filter?: BoardInput['relation_filter'];

  constructor(props: QueryProps<BoardInput>) {
    super();
    this.action = props.action;
    this.scope = props.scope;
    this.state = props.state;
    this.query = props.query;
    this.include_archived = props.include_archived;
    this.card_id = props.card_id;
    this.number = props.number;
    this.after_seq = props.after_seq;
    this.feed_before = props.feed_before;
    this.limit = props.limit;
    this.related_to = props.related_to;
    this.relation_filter = props.relation_filter;
  }
}
