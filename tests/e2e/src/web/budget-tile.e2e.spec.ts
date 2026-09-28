/**
 * The dashboard's budget tile appears only when a ceiling is actually in
 * force, and is absent otherwise.
 *
 * The absence is the part worth testing. A deployment that configured no
 * budget — every self-hosted one — must see the dashboard it always saw, with
 * no tile announcing that it has no limits. A tile saying "unlimited" would
 * advertise a constraint that does not exist here.
 */
import { expect, test } from '@playwright/test';

import { seedInsightsUsage } from '../helpers/insights.js';
import { clearAllowance, setAllowance } from '../helpers/policy-allowance.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { entityIdOf } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('dashboard budget tile', () => {
  test('is absent when no ceiling applies, and shows counters when one does', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const subjectId = await entityIdOf(seed.userB.id);
    // The tile lives in the metric grid, and a dashboard with no activity at
    // all renders its empty state instead of the grid. Seed the same fuel the
    // other dashboard specs use so the grid is on screen to be judged.
    await seedInsightsUsage(seed.userB);

    try {
      // Nothing configured: the dashboard is exactly what it always was.
      await clearAllowance(subjectId);
      await signInThroughForm(page, seed.userB);
      await page.goto('/');
      await expect(page.getByTestId('insights-page')).toBeVisible();
      await expect(page.getByTestId('insights-metric-budget')).toHaveCount(0);

      // A ceiling in force: counters, and nothing about what they cost.
      await setAllowance(subjectId, 5_000);

      await page.reload();
      const tile = page.getByTestId('insights-metric-budget');
      await expect(tile).toBeVisible();
      await expect(tile).toContainText('5,000');

      // The share of the ceiling is shown as a bar, and the bar announces the
      // true numbers rather than the clamped width it draws.
      const bar = tile.getByTestId('metric-stat-progress');
      await expect(bar).toBeVisible();
      await expect(bar).toHaveAttribute('aria-valuemax', '5000');
      await expect(bar).toHaveAttribute('aria-valuemin', '0');

      // The window is anchored at this account's start of use and turns over
      // monthly — the tile names the date the counter starts from zero again.
      await expect(tile).toContainText('Monthly window');
      await expect(tile).toContainText('resets on');
    } finally {
      await clearAllowance(subjectId);
    }
  });
});
