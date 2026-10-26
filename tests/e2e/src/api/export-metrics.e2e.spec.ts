/**
 * export_metrics end-to-end: the per-user twin of the operator instance_metrics.
 *
 * Three promises worth least if only unit-tested: it faithfully wraps the
 * /insights vitrine (`dashboard_metrics`) it rests on — same shared core, so
 * the numbers are byte-identical; the rollup-backed series and the raw-event
 * metrics AGREE on a control window (the parity the >90d substrate relies on,
 * per the value-loop brief); and it is the PERSONAL surface — it carries the
 * owner's own top_facts and none of the operator-only seat/hygiene figures.
 */
import { expect, test } from '@playwright/test';

import { seedInsightsUsage } from '../helpers/insights.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import {
  passwordGrantToken,
  provisionE2EUser,
  userRestClient,
} from '../helpers/users.js';

interface ExportMetrics {
  window: { days: number; since: string };
  metrics: Record<string, unknown> & {
    recall_calls: number;
    top_facts: unknown[];
  };
  series: Array<Record<string, number | string> & { recall_calls: number }>;
}

/** The rule gate's per-day measures, in the order the series emits them. */
const RULE_GATE_SERIES_KEYS = [
  'rule_gate_calls',
  'rules_chars_baseline',
  'rules_chars_delivered',
  'rules_full',
  'rules_judged',
  'rule_fetches',
  'guard_refusals',
  'judge_latency_ms_sum',
  'judge_unavailable',
  'judge_input_tokens',
] as const;

test.describe('export_metrics over MCP @smoke', () => {
  test('wraps the vitrine, agrees rollup-vs-raw, and stays personal', async () => {
    const user = await provisionE2EUser('export-metrics-a@zm.e2e');
    await seedInsightsUsage(user);
    const token = await passwordGrantToken(user);

    const mcp = await McpTestClient.connect(token);
    try {
      // No `days`: the window the tool reports is the one it chose itself.
      const out = firstJson<ExportMetrics>(
        await mcp.callTool('export_metrics', {})
      );

      // The default window, echoed, and the shape.
      expect(out.window.days).toBe(30);
      expect(typeof out.window.since).toBe('string');
      expect(Array.isArray(out.series)).toBe(true);

      // Stable-keyed contract: the personal value block is present…
      for (const key of [
        'recall_calls',
        'briefing_hits',
        'briefing_total',
        'saved_tokens',
        'captured_while_working',
        'live_share_den',
        'top_facts',
        'since',
      ]) {
        expect(out.metrics).toHaveProperty(key);
      }
      // …and the seeded activity actually registered.
      expect(out.metrics.recall_calls).toBeGreaterThan(0);

      // PERSONAL, not operator: the seat/hygiene figures never cross over, and
      // the owner's own top_facts do.
      expect(out.metrics).not.toHaveProperty('users_total');
      expect(out.metrics).not.toHaveProperty('hygiene_pending');
      expect(Array.isArray(out.metrics.top_facts)).toBe(true);

      // Twin parity: the tool wraps the same vitrine RPC, so scalar metrics are
      // byte-identical to a direct dashboard_metrics call as this user.
      const { data: vitrine, error } = await userRestClient(token).rpc(
        'dashboard_metrics',
        { p_days: 30 }
      );
      expect(error).toBeNull();
      const v = vitrine as Record<string, number>;
      for (const key of [
        'recall_calls',
        'briefing_hits',
        'briefing_total',
        'saved_tokens',
        'live_share_den',
        'captured_while_working',
      ]) {
        expect(out.metrics[key]).toBe(v[key]);
      }

      // Rollup-vs-raw parity on a control field: the daily series (served from
      // usage_daily, live tail included) sums to the windowed metric (computed
      // from raw usage_events). This is the invariant the >90d horizons ride on.
      const seriesRecalls = out.series.reduce(
        (sum, point) => sum + point.recall_calls,
        0
      );
      expect(seriesRecalls).toBe(out.metrics.recall_calls);

      // The rule gate's daily measures are on every point, zero or not.
      for (const point of out.series) {
        expect(Number.isInteger(point.rule_gate_calls)).toBe(true);
        expect(point.rule_gate_calls).toBeGreaterThanOrEqual(0);
      }
      // …and the SQL emits them itself: the raw series RPC carries every key
      // on every day, so the contract's defaults are not what fills them.
      const rest = userRestClient(token);
      const { data: rawSeries, error: rawError } = await rest.rpc(
        'dashboard_metrics_series',
        { p_days: 30 }
      );
      expect(rawError).toBeNull();
      for (const point of rawSeries as Array<Record<string, unknown>>) {
        for (const key of RULE_GATE_SERIES_KEYS) {
          expect(point).toHaveProperty(key);
        }
      }

      // The per-rule breakdown is the caller's own and open to them.
      const { data: stats, error: statsError } = await rest.rpc(
        'rule_gate_stats',
        { p_days: 30 }
      );
      expect(statsError).toBeNull();
      const breakdown = stats as { rules: unknown[]; refusals: unknown[] };
      expect(Array.isArray(breakdown.rules)).toBe(true);
      expect(Array.isArray(breakdown.refusals)).toBe(true);
    } finally {
      await mcp.close();
    }
  });
});
