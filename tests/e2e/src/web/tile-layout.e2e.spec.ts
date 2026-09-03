/**
 * Tile rows always end flush.
 *
 * The rule this pins down is geometric, so it is checked geometrically: tiles
 * are grouped into rows by their vertical position, and every row — including
 * a short last one — must reach the container's right edge. A fixed-column
 * grid fails this the moment the tile count is not a multiple of the column
 * count, which is exactly what a conditionally rendered tile causes.
 *
 * The budget tile is the lever: storing an allowance for the user turns the
 * KPI row from three tiles into four, so the same page is measured in both
 * arrangements.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Locator } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { seedInsightsUsage } from '../helpers/insights.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { signInThroughForm } from '../helpers/web.js';

/** Tolerance in px: sub-pixel rounding of percentage widths is not a hole. */
const FLUSH_TOLERANCE = 2;

const admin = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const entityIdOf = async (authUserId: string): Promise<string> => {
  const { data, error } = await admin()
    .from('profiles')
    .select('id')
    .eq('user_id', authUserId)
    .single();
  if (error) throw new Error(`no profile for ${authUserId}: ${error.message}`);
  return (data as { id: string }).id;
};

const clearAllowance = async (subjectId: string): Promise<void> => {
  await admin()
    .from('policy_allowances')
    .delete()
    .eq('subject_id', subjectId)
    .eq('budget_id', 'extraction');
};

interface Row {
  top: number;
  count: number;
  right: number;
}

/** Groups a container's direct children into rows and measures each row. */
const rowsOf = async (container: Locator): Promise<Row[]> =>
  container.evaluate((element) => {
    const containerRight = element.getBoundingClientRect().right;
    const byTop = new Map<number, { count: number; right: number }>();
    for (const child of Array.from(element.children)) {
      const box = child.getBoundingClientRect();
      // Round to absorb sub-pixel differences between tiles on one line.
      const key = Math.round(box.top);
      const row = byTop.get(key) ?? { count: 0, right: 0 };
      byTop.set(key, {
        count: row.count + 1,
        right: Math.max(row.right, box.right),
      });
    }
    return Array.from(byTop.entries())
      .sort(([a], [b]) => a - b)
      .map(([top, row]) => ({
        top,
        count: row.count,
        // Distance from the row's last tile to the container's edge.
        right: Math.abs(containerRight - row.right),
      }));
  });

test.describe('tile rows end flush', () => {
  test('no empty slots with three tiles or with four', async ({ page }) => {
    const seed = await readSeedState();
    const subjectId = await entityIdOf(seed.userA.id);
    await seedInsightsUsage(seed.userA);
    // A wide viewport: the arrangement being tested is the wide-screen one.
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInThroughForm(page, seed.userA);

    try {
      // Three tiles — a single full row.
      await clearAllowance(subjectId);
      await page.goto('/');
      const grid = page
        .getByTestId('insights-metric-timeSaved')
        .locator('xpath=../..');
      await expect(page.getByTestId('insights-metric-budget')).toHaveCount(0);

      let rows = await rowsOf(grid);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.count).toBe(3);
      expect(rows[0]?.right).toBeLessThanOrEqual(FLUSH_TOLERANCE);

      // Four tiles — two even rows, and the second one still reaches the edge.
      const { error } = await admin().from('policy_allowances').upsert({
        subject_id: subjectId,
        budget_id: 'extraction',
        limit_value: 5_000,
      });
      if (error)
        throw new Error(`could not store an allowance: ${error.message}`);

      await page.reload();
      await expect(page.getByTestId('insights-metric-budget')).toBeVisible();

      rows = await rowsOf(grid);
      expect(rows).toHaveLength(2);
      // 2 + 2 rather than 3 + 1: rows are evened out, not filled greedily.
      expect(rows.map((row) => row.count)).toEqual([2, 2]);
      for (const row of rows) {
        expect(row.right).toBeLessThanOrEqual(FLUSH_TOLERANCE);
      }
    } finally {
      await clearAllowance(subjectId);
    }
  });
});
