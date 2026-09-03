import type { SessionReceiptInput } from '@workspace/contracts';
import { Query, type QueryProps } from '@workspace/domain';

/**
 * Per-session value counters for the end-of-session receipt. Props mirror the
 * `sessionReceiptInputSchema` contract.
 */
export class SessionReceiptQuery extends Query implements SessionReceiptInput {
  public readonly since: string;

  constructor(props: QueryProps<SessionReceiptInput>) {
    super();
    this.since = props.since;
  }
}
