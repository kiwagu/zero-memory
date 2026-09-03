/**
 * Reflection queue (/reflections): the owner reviews episode-cluster
 * consolidation drafts. Approving WRITES the distillate as a real memory
 * (embedded through the server) with derived_from provenance to every source
 * episode — the sources stay live. Dismissing is terminal; a non-owner never
 * sees the cluster. Each spec seeds its own uniquely-marked candidate so
 * retries and parallel workers stay independent.
 */
import { expect, test } from '@playwright/test';

import {
  countDerivedFromLinks,
  readReflectionCandidate,
  seedReflectionCandidate,
} from '../helpers/reflections.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { provisionE2EUser } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

/**
 * Dedicated owner account: the seed inserts episode memories, and the shared
 * seed users' datasets carry invariants other specs assert concurrently
 * (memory search compares two live reads of userA's corpus mid-run).
 */
const reflectionsOwner = () => provisionE2EUser('reflections-owner@zm.e2e');

test.describe('reflection queue', () => {
  test('@smoke owner sees a pending consolidation with draft and sources', async ({
    page,
  }) => {
    const owner = await reflectionsOwner();
    const seeded = await seedReflectionCandidate(owner);
    await signInThroughForm(page, owner);
    await page.goto('/reflections');

    const card = page
      .getByTestId('reflection-candidate')
      .filter({ hasText: seeded.marker })
      .first();
    await expect(card).toBeVisible();
    await expect(card.getByTestId('reflection-draft')).toContainText(
      seeded.marker
    );
    // All three source episodes render as links to their memory pages.
    await expect(
      card.getByTestId('reflection-members').getByRole('link')
    ).toHaveCount(3);
    await expect(card.getByTestId('reflection-kind')).toContainText('fact');
  });

  test('approving writes the consolidated memory with provenance', async ({
    page,
  }) => {
    const owner = await reflectionsOwner();
    const seeded = await seedReflectionCandidate(owner);
    await signInThroughForm(page, owner);
    await page.goto('/reflections');

    const card = page
      .getByTestId('reflection-candidate')
      .filter({ hasText: seeded.marker })
      .first();
    await expect(card).toBeVisible();
    await card.getByTestId('reflection-approve').click();

    // The card leaves the pending queue and lands on the approved shelf with
    // a link to the written memory.
    const approvedCard = page
      .getByTestId('reflection-candidate')
      .filter({ hasText: seeded.marker })
      .filter({ has: page.getByTestId('reflection-approved') })
      .first();
    await expect(approvedCard).toBeVisible();

    // The row records the written memory, and the provenance links exist:
    // one derived_from edge to every source episode.
    const row = await readReflectionCandidate(seeded.candidateId);
    expect(row.status).toBe('approved');
    expect(row.approvedMemoryId).not.toBeNull();
    expect(
      await countDerivedFromLinks(row.approvedMemoryId!, seeded.episodeIds)
    ).toBe(seeded.episodeIds.length);

    // The distillate is a real, owned memory: its detail page renders.
    await approvedCard.getByTestId('reflection-approved-link').click();
    await expect(page).toHaveURL(
      new RegExp(`/memory/${row.approvedMemoryId}$`)
    );
    await expect(page.getByTestId('memory-detail-content')).toContainText(
      seeded.marker
    );
  });

  test('dismissing clears the candidate from the queue', async ({ page }) => {
    const owner = await reflectionsOwner();
    const seeded = await seedReflectionCandidate(owner);
    await signInThroughForm(page, owner);
    await page.goto('/reflections');

    const card = page
      .getByTestId('reflection-candidate')
      .filter({ hasText: seeded.marker })
      .first();
    await expect(card).toBeVisible();
    await card.getByTestId('reflection-dismiss').click();

    await expect(
      page
        .getByTestId('reflection-candidate')
        .filter({ hasText: seeded.marker })
    ).toHaveCount(0);
    expect((await readReflectionCandidate(seeded.candidateId)).status).toBe(
      'dismissed'
    );
  });

  test('@smoke a non-owner sees no candidates (owner-scoped queue)', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const owner = await reflectionsOwner();
    const seeded = await seedReflectionCandidate(owner); // owner's cluster…
    await signInThroughForm(page, seed.userB); // …B must never see it.
    await page.goto('/reflections');

    await expect(page.locator('body')).not.toContainText(seeded.marker);
  });
});
