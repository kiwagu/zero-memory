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

test.describe('export_metrics over MCP @smoke', () => {
  test('wraps the vitrine, agrees rollup-vs-raw, and stays personal', async () => {
    const user = await provisionE2EUser('export-metrics-a@zm.e2e');
    await seedInsightsUsage(user);
    const token = await passwordGrantToken(user);

    const mcp = await McpTestClient.connect(token);
    try {
      const out = firstJson<ExportMetrics>(
        await mcp.callTool('export_metrics', { days: 30 })
      );

      // Window echo and shape.
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
    } finally {
      await mcp.close();
    }
  });

  test('defaults the window to 30 days and rejects an out-of-range horizon', async () => {
    const user = await provisionE2EUser('export-metrics-b@zm.e2e');
    const token = await passwordGrantToken(user);
    const mcp = await McpTestClient.connect(token);
    try {
      // Omitted days → the contract default.
      const def = firstJson<ExportMetrics>(
        await mcp.callTool('export_metrics', {})
      );
      expect(def.window.days).toBe(30);

      // Above the 365-day ceiling → input validation rejects it.
      const tooWide = await mcp.callTool('export_metrics', { days: 400 });
      expect(tooWide.isError ?? false).toBe(true);
    } finally {
      await mcp.close();
    }
  });
});
