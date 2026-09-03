/**
 * Memory feed and fact card against the current UI: the feed renders the
 * seeded fixture memories, and opening one shows the detail card with the
 * lifecycle and provenance sections.
 */
import { expect, test } from '@playwright/test';

import { FIXTURE_MEMORIES } from '../helpers/fixture-memories.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('memory feed and fact card', () => {
  test('@smoke feed renders the seeded fixture memories', async ({ page }) => {
    const seed = await readSeedState();
    await signInThroughForm(page, seed.userA);
    await page.goto('/memories');

    // The feed lists memories at all…
    const cards = page.getByTestId('memory-card');
    await expect(cards.first()).toBeVisible();
    // …and each fixture renders with its content. Addressed through the feed's
    // own search rather than the top of the list: the feed is newest-first and
    // every other spec in the run writes memories for this user, so fixtures
    // seeded at run start drift off the first page as the suite grows — a
    // position-dependent assertion fails on corpus size, not on behavior.
    for (const fixture of FIXTURE_MEMORIES) {
      const memoryId = seed.fixtureMemoryIds[fixture.content]!;
      await page.goto(
        `/memories?q=${encodeURIComponent(memoryId.slice(0, 12))}`
      );
      await expect(
        page
          .getByTestId('memory-feed')
          .getByText(fixture.content.slice(0, 60), { exact: false })
          .first()
      ).toBeVisible();
    }
  });

  test('@smoke a memory with an original reveals it via the disclosure', async ({
    page,
  }) => {
    const seed = await readSeedState();
    // The preference fixture carries a verbatim (original-language) phrase.
    const fixture = FIXTURE_MEMORIES[0]!;
    const memoryId = seed.fixtureMemoryIds[fixture.content]!;
    await signInThroughForm(page, seed.userA);
    // Addressed by id through the feed's search — see the first test: the
    // fixture is not on the first page once the suite's other specs have
    // written for this user.
    await page.goto(`/memories?q=${encodeURIComponent(memoryId.slice(0, 12))}`);

    const card = page
      .getByTestId('memory-card')
      .filter({ hasText: fixture.content.slice(0, 50) })
      .first();
    const toggle = card.getByTestId('memory-original-toggle');
    await expect(toggle).toBeVisible();
    // Collapsed by default, then revealed on click — native <details>.
    await toggle.click();
    await expect(card.getByTestId('memory-original-text')).toContainText(
      fixture.verbatim!.slice(0, 20)
    );
  });

  test('searching by a mem_ id prefix finds exactly that memory', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const fixture = FIXTURE_MEMORIES[1]!;
    const memoryId = seed.fixtureMemoryIds[fixture.content]!;
    // What a user copies from a card: the id's visible head, not the full id.
    const prefix = memoryId.slice(0, 12);
    await signInThroughForm(page, seed.userA);
    await page.goto(`/memories?q=${encodeURIComponent(prefix)}`);

    const cards = page.getByTestId('memory-card');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText(fixture.content.slice(0, 60));
  });

  test('@smoke fact card opens with content and provenance', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const fixture = FIXTURE_MEMORIES[2]!;
    const memoryId = seed.fixtureMemoryIds[fixture.content]!;
    await signInThroughForm(page, seed.userA);
    // Addressed by id through the feed's search — see the first test.
    await page.goto(`/memories?q=${encodeURIComponent(memoryId.slice(0, 12))}`);

    await page
      .getByTestId('memory-feed')
      .getByText(fixture.content.slice(0, 60), { exact: false })
      .first()
      .click();

    // `?from=…` may trail the path: a card opened from a FILTERED feed carries
    // the filter so its back link returns to that view.
    await expect(page).toHaveURL(new RegExp(`/memory/${memoryId}(\\?|$)`));
    await expect(page.getByTestId('memory-detail-content')).toContainText(
      fixture.content.slice(0, 60)
    );
    // Provenance renders either the source JSON or the explicit no-source
    // state — the section itself must always be present on a fact card.
    await expect(page.getByTestId('memory-provenance')).toBeVisible();
  });
});
