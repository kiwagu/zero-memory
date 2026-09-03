/**
 * Version history on the fact card: when a memory has been superseded by a
 * newer version, opening the current version shows the version-history section
 * with the older, superseded version — and that older version is reachable and
 * marked invalidated. Each spec seeds its own chain so order never matters.
 */
import { expect, test } from '@playwright/test';

import { readSeedState } from '../helpers/runtime-state.js';
import { seedVersionChain } from '../helpers/version-history.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('memory version history', () => {
  test('@smoke current version lists its older superseded version', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const chain = await seedVersionChain(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto(`/memory/${chain.currentId}`);

    // The live current version shows an open validity window ("… — present").
    await expect(page.getByTestId('memory-validity')).toBeVisible();

    const history = page.getByTestId('memory-version-history');
    await expect(history).toBeVisible();
    // The older version's preview is present and links to its detail page.
    await expect(history).toContainText(chain.oldContent.slice(0, 40));
    await history
      .getByRole('link', { name: new RegExp(chain.oldContent.slice(0, 20)) })
      .click();
    await expect(page).toHaveURL(new RegExp(`/memory/${chain.oldId}$`));

    // The older version was invalidated by the system (no usr_): the detail
    // card attributes the scanner + judge model instead of an empty source.
    const detail = page.getByTestId('memory-detail-content');
    await expect(detail).toBeVisible();
    await expect(page.locator('body')).toContainText(
      `${chain.invalidatorAgent} · ${chain.invalidatorModel}`
    );
  });

  test('@smoke feed flags a memory that has version history', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const chain = await seedVersionChain(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/memories');

    const card = page
      .getByTestId('memory-card')
      .filter({ hasText: chain.currentContent.slice(0, 40) });
    await expect(card.first()).toBeVisible();
    await expect(
      card.first().getByTestId('memory-history-badge')
    ).toBeVisible();
  });

  test('a memory with no other versions shows no history section', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const fixtureId = Object.values(seed.fixtureMemoryIds)[0]!;
    await signInThroughForm(page, seed.userA);
    await page.goto(`/memory/${fixtureId}`);

    await expect(page.getByTestId('memory-detail-content')).toBeVisible();
    await expect(page.getByTestId('memory-version-history')).toHaveCount(0);
  });
});
