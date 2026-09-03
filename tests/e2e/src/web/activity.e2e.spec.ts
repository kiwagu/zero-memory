/**
 * Memory activity feed (/activity): the owner sees one row per seeded
 * recall/build_context event with hit/empty outcome badges, and the "empty"
 * filter excludes hits. Events are append-only and content-free, so specs
 * assert presence of badges, never exact counts — retries and parallel seeds
 * stay green.
 */
import { expect, test } from '@playwright/test';

import {
  seedActivityRowWithManyFacts,
  seedInsightsUsage,
} from '../helpers/insights.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('memory activity feed', () => {
  test('revealing the held-back facts does not reload the feed', async ({
    page,
  }) => {
    // The complaint this pins: the reveal used to be a link back to the page,
    // so the whole feed re-rendered and the row the reader was looking at
    // moved out from under them. It must now open in place.
    const seed = await readSeedState();
    const { memoryIds } = await seedActivityRowWithManyFacts(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/activity');

    const row = page
      .getByTestId('activity-row')
      .filter({ hasText: 'more facts than a row shows' })
      .first();
    await row.getByTestId('activity-toggle').click();

    const reveal = row.getByTestId('activity-more');
    await expect(reveal).toBeVisible();
    const lastFact = row.getByText(
      `surfaced fact number ${memoryIds.length}.`,
      { exact: false }
    );
    await expect(lastFact).toBeHidden();

    const urlBefore = page.url();
    await reveal.click();

    await expect(lastFact).toBeVisible();
    // No navigation happened: same URL, and the row is still open.
    expect(page.url()).toBe(urlBefore);
    await expect(row.getByTestId('activity-facts')).toBeVisible();
  });

  test('@smoke owner sees the feed with hit and empty outcomes', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedInsightsUsage(seed.userA); // 2 hits + 1 empty recall
    await signInThroughForm(page, seed.userA);
    await page.goto('/activity');

    await expect(page.getByTestId('activity-page')).toBeVisible();
    await expect(page.getByTestId('activity-row').first()).toBeVisible();
    // The seed guarantees at least one hit and one empty event in the window.
    await expect(
      page.getByTestId('activity-outcome-green').first()
    ).toBeVisible();
    await expect(
      page.getByTestId('activity-outcome-amber').first()
    ).toBeVisible();

    // A hit row expands into its surfaced-fact previews, each linking to the
    // fact's detail page — the drill-down that makes the feed inspectable,
    // announced by the chevron that marks the row as openable.
    const hitRow = page
      .getByTestId('activity-row')
      .filter({ has: page.getByTestId('activity-outcome-green') })
      .first();
    await expect(hitRow.getByTestId('activity-toggle')).toBeVisible();
    await hitRow.locator('summary').click();
    const facts = hitRow.getByTestId('activity-facts');
    await expect(facts).toBeVisible();
    await expect(facts.getByRole('link').first()).toHaveAttribute(
      'href',
      /\/memory\/mem_/
    );
  });

  test('the empty filter shows only empty recalls', async ({ page }) => {
    const seed = await readSeedState();
    await seedInsightsUsage(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/activity?f=empty');

    await expect(page.getByTestId('activity-page')).toBeVisible();
    await expect(page.getByTestId('activity-row').first()).toBeVisible();
    // Hits and errors are filtered out entirely; only empty (amber) remain.
    await expect(page.getByTestId('activity-outcome-green')).toHaveCount(0);
    await expect(page.getByTestId('activity-outcome-destructive')).toHaveCount(
      0
    );
    await expect(
      page.getByTestId('activity-outcome-amber').first()
    ).toBeVisible();

    // The query that came back empty IS the row's story, so it reads off the
    // header's second line without opening anything; expanding an empty row
    // adds only the request id and never a fact list.
    const emptyRow = page
      .getByTestId('activity-row')
      .filter({ hasText: 'quokka retry budget' })
      .first();
    await expect(emptyRow.getByTestId('activity-query')).toContainText(
      'what is the quokka retry budget?'
    );
    await emptyRow.locator('summary').click();
    await expect(emptyRow.getByTestId('activity-detail-header')).toContainText(
      'req_'
    );
    await expect(emptyRow.getByTestId('activity-facts')).toHaveCount(0);
  });

  test('the errors filter shows only failed recalls, attributed to the agent', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedInsightsUsage(seed.userA); // includes one error by "e2e-agent"
    await signInThroughForm(page, seed.userA);
    await page.goto('/activity?f=errors');

    await expect(page.getByTestId('activity-page')).toBeVisible();
    const rows = page.getByTestId('activity-row');
    await expect(rows.first()).toBeVisible();
    await expect(
      page.getByTestId('activity-outcome-destructive').first()
    ).toBeVisible();
    await expect(page.getByTestId('activity-outcome-green')).toHaveCount(0);
    await expect(page.getByTestId('activity-outcome-amber')).toHaveCount(0);
    // The failed call is attributed to the MCP client that ran it.
    await expect(rows.first()).toContainText('e2e-agent');

    // The query that failed — the detail that explains the outcome — is on
    // the row header itself, before any click.
    const errorRow = rows.filter({ hasText: 'quokka export failed' }).first();
    await expect(errorRow.getByTestId('activity-query')).toContainText(
      'which quokka export failed?'
    );
  });
});
