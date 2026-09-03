import { describe, expect, it } from 'vitest';

import {
  instanceMetricsSchema,
  instanceMetricsSeriesPointSchema,
} from './instance-metrics.schema.js';
import {
  exportMetricsInputSchema,
  exportMetricsMetricsSchema,
  exportMetricsOutputSchema,
  exportMetricsSeriesPointSchema,
} from './tools.schema.js';

/**
 * The per-user export is the twin of the operator surface: both rest on the
 * shared value definitions, so its key set is pinned RELATIVE to
 * `instanceMetricsSchema` (drift guard) and its full shape is snapshot so the
 * exported key set stays a stable contract consumers can depend on.
 */

// Operator-only figures the personal export must NOT carry.
const OPERATOR_ONLY = [
  'users_total',
  'users_active',
  'hygiene_pending',
  'eval_runs',
] as const;

describe('export_metrics input', () => {
  it('defaults days to 30 when omitted', () => {
    expect(exportMetricsInputSchema.parse({}).days).toBe(30);
  });

  it('clamps the horizon to [1, 365]', () => {
    expect(() => exportMetricsInputSchema.parse({ days: 0 })).toThrow();
    expect(() => exportMetricsInputSchema.parse({ days: 366 })).toThrow();
    expect(exportMetricsInputSchema.parse({ days: 365 }).days).toBe(365);
  });
});

describe('export_metrics metric keys (twin of the operator surface)', () => {
  it('is the shared value block minus operator-only figures, plus top_facts', () => {
    const shared = Object.keys(instanceMetricsSchema.shape).filter(
      (k) => !(OPERATOR_ONLY as readonly string[]).includes(k)
    );
    const expected = new Set([...shared, 'top_facts']);
    expect(new Set(Object.keys(exportMetricsMetricsSchema.shape))).toEqual(
      expected
    );
  });

  it('carries the owner-only top_facts the operator surface omits', () => {
    expect(exportMetricsMetricsSchema.shape).toHaveProperty('top_facts');
  });

  it('series point is the operator point minus the aggregate users_active', () => {
    const expected = new Set(
      Object.keys(instanceMetricsSeriesPointSchema.shape).filter(
        (k) => k !== 'users_active'
      )
    );
    expect(new Set(Object.keys(exportMetricsSeriesPointSchema.shape))).toEqual(
      expected
    );
  });
});

describe('export_metrics output (stable-keyed contract)', () => {
  const metrics: Record<string, unknown> = {};
  for (const k of Object.keys(exportMetricsMetricsSchema.shape)) {
    metrics[k] = 0;
  }
  metrics.top_facts = [];
  metrics.age_buckets = [];
  metrics.last_captured_at = null;
  metrics.stale_median_days = null;
  metrics.corpus_median_age_days = null;
  metrics.since = new Date(0).toISOString();

  const seriesPoint: Record<string, unknown> = {};
  for (const k of Object.keys(exportMetricsSeriesPointSchema.shape)) {
    seriesPoint[k] = 0;
  }
  seriesPoint.date = '1970-01-01';

  const payload = {
    window: { days: 7, since: new Date(0).toISOString() },
    metrics,
    series: [seriesPoint],
  };

  it('accepts a well-formed payload', () => {
    expect(exportMetricsOutputSchema.parse(payload)).toBeTruthy();
  });

  it('has a stable top-level and metric key set', () => {
    const parsed = exportMetricsOutputSchema.parse(payload);
    expect(Object.keys(parsed).sort()).toEqual(['metrics', 'series', 'window']);
    expect(Object.keys(parsed.metrics).sort()).toMatchInlineSnapshot(`
      [
        "age_buckets",
        "briefing_hits",
        "briefing_total",
        "captured_while_working",
        "corpus_median_age_days",
        "empty_recall_den",
        "empty_recall_num",
        "entities_24h",
        "entities_total",
        "faded_den",
        "faded_num",
        "last_captured_at",
        "live_share_den",
        "live_share_num",
        "memories_24h",
        "precision_den",
        "precision_num",
        "recall_calls",
        "recall_used_events",
        "reinforced_den",
        "reinforced_num",
        "saved_tokens",
        "scope_coverage",
        "since",
        "stale_median_days",
        "stale_over_90_num",
        "top_facts",
        "usefulness_den",
        "usefulness_num",
        "write_tokens_saved",
      ]
    `);
    expect(Object.keys(parsed.series[0]!).sort()).toMatchInlineSnapshot(`
      [
        "briefing_hits",
        "briefing_total",
        "captured",
        "date",
        "judged",
        "recall_calls",
        "relevant",
        "saved_tokens",
        "used",
        "write_tokens",
      ]
    `);
  });
});
