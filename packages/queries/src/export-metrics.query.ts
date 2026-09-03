import type { ExportMetricsInput } from '@workspace/contracts';
import { Query, type QueryProps } from '@workspace/domain';

/**
 * The caller's own /insights metrics + daily series for a window. Props mirror
 * the `exportMetricsInputSchema` contract.
 */
export class ExportMetricsQuery extends Query implements ExportMetricsInput {
  public readonly days: number;

  constructor(props: QueryProps<ExportMetricsInput>) {
    super();
    this.days = props.days;
  }
}
