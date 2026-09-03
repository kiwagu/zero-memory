import type { MemoryKind, RecallInput } from '@workspace/contracts';
import { Query, type QueryProps } from '@workspace/domain';

/**
 * Hybrid memory search. Props mirror the `recallInputSchema` contract.
 */
export class RecallQuery extends Query implements RecallInput {
  public readonly query: string;
  public readonly scopes?: string[];
  public readonly kinds?: MemoryKind[];
  public readonly k?: number;
  public readonly include_graph?: boolean;
  public readonly project_hint?: string;
  /** The thread token a reconnected session presents to keep its project. */
  public readonly thread?: string;

  constructor(props: QueryProps<RecallInput>) {
    super();
    this.query = props.query;
    this.scopes = props.scopes;
    this.kinds = props.kinds;
    this.k = props.k;
    this.include_graph = props.include_graph;
    this.project_hint = props.project_hint;
    this.thread = props.thread;
  }
}
