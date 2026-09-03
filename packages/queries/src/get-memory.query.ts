import { Query } from '@workspace/domain';

/**
 * One full-fidelity memory by canonical id — the read behind the
 * `zm://memory/{id}` resource. RLS decides visibility: an id the caller
 * cannot see resolves the same as one that does not exist.
 */
export class GetMemoryQuery extends Query {
  constructor(public readonly memoryId: string) {
    super();
  }
}
