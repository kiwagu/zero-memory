/**
 * Value dashboard (/, the default page): owner sees their metric tiles + top facts
 * built from seeded usage_events, the period switch keeps the page rendering,
 * and top facts are owner-scoped (user B never sees user A's content). Each spec
 * seeds its own fuel so order and retries never matter.
 */
import { expect, test } from '@playwright/test';

import {
  seedInsightsUsage,
  seedRelevanceVerdict,
  seedRoiRun,
  seedWeeklyDigestUsage,
} from '../helpers/insights.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { provisionE2EUser } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('value dashboard', () => {
  test('@smoke owner sees metric tiles and their top fact', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedInsightsUsage(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/');

    await expect(page.getByTestId('insights-page')).toBeVisible();
    await expect(page.getByTestId('insights-inventory')).toBeVisible();
    await expect(page.getByTestId('insights-tokens-saved')).toBeVisible();
    await expect(page.getByTestId('insights-metric-timeSaved')).toBeVisible();
    await expect(
      page.getByTestId('insights-metric-emptyRecalls')
    ).toBeVisible();
    await expect(page.getByTestId('insights-metric-staleness')).toBeVisible();
    // The quality tile is phased: the seed emits no recall_used events, so the
    // reinforced proxy renders and the usefulness tile must NOT — they are
    // mutually exclusive by design.
    await expect(page.getByTestId('insights-metric-reinforced')).toBeVisible();
    await expect(page.getByTestId('insights-metric-usefulness')).toHaveCount(0);
    // No watcher judge has scored user A's recalls anywhere in this suite, so
    // context precision shows the connect placeholder — never a 0%.
    const precision = page.getByTestId('insights-metric-precision');
    await expect(precision).toBeVisible();
    await expect(precision).toContainText('—');
    // Same grace pattern for the counterfactual benchmark: user A never runs
    // one in this suite, so the tile invites instead of showing 0%.
    const roi = page.getByTestId('insights-metric-roi');
    await expect(roi).toBeVisible();
    await expect(roi).toContainText('—');

    // Corpus-age vitrine: the seeded corpus is live, so both age tiles render
    // real values (a fresh corpus fades at 0%) and all five buckets are shown.
    await expect(page.getByTestId('insights-metric-faded')).toContainText('%');
    await expect(page.getByTestId('insights-metric-corpusAge')).toBeVisible();
    await expect(page.getByTestId('insights-age-buckets')).toBeVisible();

    await expect(page.getByTestId('insights-comparison-chart')).toBeVisible();
    await expect(page.getByTestId('insights-activity-chart')).toBeVisible();

    const topFacts = page.getByTestId('insights-top-facts');
    await expect(topFacts).toBeVisible();

    // Top-facts membership is SHARED state: the list is the top 5 by surfaced
    // count for the whole user, and every parallel spec's ad-hoc recalls keep
    // bumping other memories — pinning the seeded fact into the top-5 is
    // worker-order luck. Assert the drill-down mechanism instead: any listed
    // fact renders content (the RPC returns owned facts only) and links to
    // its memory detail page.
    const firstFact = topFacts.getByRole('link').first();
    const href = await firstFact.getAttribute('href');
    expect(href).toMatch(/\/memory\/mem_/);
    await firstFact.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByTestId('memory-detail-content')).toBeVisible();
  });

  test('the period switch keeps the dashboard rendering', async ({ page }) => {
    const seed = await readSeedState();
    await seedInsightsUsage(seed.userA);
    await signInThroughForm(page, seed.userA);

    await page.goto('/?days=7');
    await expect(page.getByTestId('insights-page')).toBeVisible();
    await expect(page.getByTestId('insights-tokens-saved')).toBeVisible();
  });

  test('context precision shows a rate once a judge scored recalls', async ({
    page,
  }) => {
    const seed = await readSeedState();
    // User B (and only B) gets a judge relevance verdict, so this spec stays
    // independent of A's placeholder assertion under parallel workers.
    const seeded = await seedInsightsUsage(seed.userB);
    await seedRelevanceVerdict(seeded.ownerId, seeded.memoryId);
    await signInThroughForm(page, seed.userB);
    await page.goto('/');

    const precision = page.getByTestId('insights-metric-precision');
    await expect(precision).toBeVisible();
    await expect(precision).toContainText('%');
  });

  test('the roi tile shows the exclusive rate after a benchmark run', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const seeded = await seedInsightsUsage(seed.userB);
    await seedRoiRun(seeded.ownerId, seeded.memoryId);
    await signInThroughForm(page, seed.userB);
    await page.goto('/');

    const roi = page.getByTestId('insights-metric-roi');
    await expect(roi).toBeVisible();
    await expect(roi).toContainText('%');
  });

  test('@smoke the weekly digest compares this week against last', async ({
    page,
  }) => {
    // A dedicated user with a two-week backdated series, so the "this week vs
    // last" split is deterministic and unaffected by other specs' today-only
    // fuel on the shared users.
    const user = await provisionE2EUser('insights-digest@zm.e2e');
    await seedWeeklyDigestUsage(user);
    await signInThroughForm(page, user);
    await page.goto('/');

    const digest = page.getByTestId('insights-digest');
    await expect(digest).toBeVisible();
    // The section is a period-over-period comparison: at least one tile carries
    // a "vs last week" delta (the seeded briefings give a positive token delta).
    await expect(digest).toContainText(/vs last week/i);
  });

  test('@smoke top facts are owner-scoped (B never sees A content)', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const seededA = await seedInsightsUsage(seed.userA); // A surfaces a fact…
    await signInThroughForm(page, seed.userB); // …B must not see its content.
    await page.goto('/');

    await expect(page.getByTestId('insights-page')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(
      seededA.content.slice(0, 40)
    );
  });
});
