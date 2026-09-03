import type { ExportMetricsOutput } from '@workspace/contracts';
import { inject } from '@workspace/di';

/**
 * Port: the caller's own windowed /insights metrics plus the daily series
 * behind them. A new consumer of existing metering (usage_events / usage_daily
 * via the `dashboard_metrics` + `dashboard_metrics_series` RPCs), never a new
 * metric. Runs as the current user: the adapter's RPCs key every aggregate on
 * the caller — the per-user twin of the service-role `instance_metrics`.
 */
export interface IExportMetricsReader {
  /** Windowed metrics + oldest-first daily series for the last `days` days. */
  read(days: number): Promise<ExportMetricsOutput>;
}

export const EXPORT_METRICS_READER = Symbol.for(
  'zero-memory:export-metrics-reader'
);

export const injectExportMetricsReader = () => inject(EXPORT_METRICS_READER);
