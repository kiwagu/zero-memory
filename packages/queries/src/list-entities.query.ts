import type { EntitiesInput } from '@workspace/contracts';
import { Query, type QueryProps } from '@workspace/domain';

/**
 * List/search knowledge-graph entities. Props mirror the
 * `entitiesInputSchema` contract.
 */
export class ListEntitiesQuery extends Query implements EntitiesInput {
  public readonly query?: string;
  public readonly scope?: string;

  constructor(props: QueryProps<EntitiesInput>) {
    super();
    this.query = props.query;
    this.scope = props.scope;
  }
}
