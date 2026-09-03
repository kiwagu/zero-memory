import { injectContext, type IContext } from '@workspace/context';
import {
  exportMetricsMetricsSchema,
  exportMetricsOutputSchema,
  exportMetricsSeriesPointSchema,
  type ExportMetricsOutput,
} from '@workspace/contracts';
import { singleton } from '@workspace/di';
import { type IExportMetricsReader } from '@workspace/memory';
import { z } from 'zod';

import { createUserClient, type Client } from '../supabase.client.js';

/**
 * Supabase adapter for the export-metrics read port: the two per-user vitrine
 * RPCs (`dashboard_metrics` + `dashboard_metrics_series`, both security
 * definer, keyed on the current user inside the function). The metrics side
 * rests on `private.dashboard_metrics_core` — the same core the operator
 * `instance_metrics` aggregates — so the definitions cannot drift. Read-only.
 */
@singleton()
export class SupabaseExportMetricsReader implements IExportMetricsReader {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async read(days: number): Promise<ExportMetricsOutput> {
    const client = this.#client();

    const [metricsRes, seriesRes] = await Promise.all([
      client.rpc('dashboard_metrics', { p_days: days }),
      client.rpc('dashboard_metrics_series', { p_days: days }),
    ]);
    if (metricsRes.error) {
      throw new Error(`dashboard_metrics failed: ${metricsRes.error.message}`);
    }
    if (seriesRes.error) {
      throw new Error(
        `dashboard_metrics_series failed: ${seriesRes.error.message}`
      );
    }

    const metrics = exportMetricsMetricsSchema.parse(metricsRes.data);
    const series = z
      .array(exportMetricsSeriesPointSchema)
      .parse(seriesRes.data);

    return exportMetricsOutputSchema.parse({
      window: { days, since: metrics.since },
      metrics,
      series,
    });
  }

  #client(): Client {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      throw new Error('No access token in the execution context.');
    }
    return createUserClient(accessToken);
  }
}
