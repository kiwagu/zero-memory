/**
 * Memory-hygiene review surface: the owner sees a queued conflict, resolving it
 * clears it, and the queue is owner-scoped (one owner's conflict never reaches
 * another). Each spec seeds its own conflict so order and retries never matter —
 * and the owner-scoping spec asserts on THAT conflict rather than on an empty
 * page, because every user accumulates conflicts of their own as a full run
 * writes.
 */
import { expect, test } from '@playwright/test';

import { memoryProvenance, seedReviewConflict } from '../helpers/review.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('memory-hygiene review surface', () => {
  test('@smoke owner sees a queued conflict with both memories', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const conflict = await seedReviewConflict(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/review');

    const item = page.getByTestId('review-item');
    await expect(item.first()).toBeVisible();
    await expect(item.first()).toContainText(conflict.contentA.slice(0, 40));
    await expect(item.first()).toContainText(conflict.contentB.slice(0, 40));
  });

  test('resolving a conflict clears it from the queue', async ({ page }) => {
    const seed = await readSeedState();
    await seedReviewConflict(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/review');

    await expect(page.getByTestId('review-item').first()).toBeVisible();
    await page.getByTestId('review-resolve-keep_both').first().click();
    // The only pending conflict is gone → the empty state shows.
    await expect(page.getByTestId('review-empty')).toBeVisible();
  });

  test("@smoke a non-owner never sees another owner's conflict", async ({
    page,
  }) => {
    const seed = await readSeedState();
    const conflict = await seedReviewConflict(seed.userA); // A owns a conflict…
    await signInThroughForm(page, seed.userB); // …B must not see it.
    await page.goto('/review');

    // Wait for the surface to resolve either way before counting.
    await expect(
      page
        .getByTestId('review-empty')
        .or(page.getByTestId('review-item').first())
    ).toBeVisible();

    // Assert on A'S conflict, NOT on an empty page. B accumulates conflicts of
    // its own from the writes other specs make during the same run, so "the
    // queue is empty" pins the suite's ordering rather than the owner scoping
    // this spec exists for — and it was failing on exactly that, in a way only
    // the full suite could show.
    await expect(
      page
        .getByTestId('review-item')
        .filter({ hasText: conflict.contentA.slice(0, 40) })
    ).toHaveCount(0);
    await expect(
      page
        .getByTestId('review-item')
        .filter({ hasText: conflict.contentB.slice(0, 40) })
    ).toHaveCount(0);
  });

  test('merging a conflict replaces both memories with a new one', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedReviewConflict(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/review');

    await expect(page.getByTestId('review-item').first()).toBeVisible();
    await page.getByTestId('review-merge-open').first().click();

    const merged =
      'Production deploys are allowed on Fridays only with explicit sign-off.';
    const textarea = page.getByTestId('review-merge-text');
    await expect(textarea).toBeVisible();
    await textarea.fill(merged);
    await page.getByTestId('review-merge-submit').click();

    // The pair is resolved (superseded by the merged memory) → queue is empty.
    await expect(page.getByTestId('review-empty')).toBeVisible();

    // The owner TYPED this text, so the row must say a person wrote it. Every
    // other write in the product is an agent's; this is the one that is not,
    // and `remember` cannot tell who was at the keyboard.
    const provenance = await memoryProvenance(seed.userA, merged);
    expect(
      provenance.authorKind,
      'a merge the owner typed must be recorded as human-authored'
    ).toBe('human');
    // The client still identifies the dashboard: authorship says WHO wrote it,
    // the client says THROUGH WHAT — and the metrics that exclude `zm-web`
    // from agent activity keep working because this half is unchanged.
    expect(provenance.agentName).toBe('zm-web');
  });
});
