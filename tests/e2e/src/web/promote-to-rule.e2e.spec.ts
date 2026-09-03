/**
 * Memory-detail "Promote to rule" flow: the owner turns a memory into a
 * promoted rule straight from its detail page; a candidacy the owner already
 * dismissed is revived only by an explicit second, "promote anyway" click.
 * Each spec seeds its own memory (distinct content) and runs as user B so
 * order, retries, and user A's incubator-queue specs never interfere (the
 * queue is owner-scoped, so B's promoted rows are invisible to A's asserts).
 */
import { expect, test } from '@playwright/test';

import {
  seedDismissedRuleCandidate,
  seedOwnedMemory,
} from '../helpers/rules.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { signInThroughForm } from '../helpers/web.js';

const PROMOTE_CONTENT =
  'E2E promote fixture: prefer explicit imports over wildcard re-exports.';

const DISMISSED_FIXTURE = {
  content: 'E2E dismissed-promote fixture: pin CI tool versions explicitly.',
  ruleText: 'Pin CI tool versions explicitly instead of tracking latest.',
};

test.describe('memory-detail promote to rule', () => {
  test('@smoke owner promotes a memory from its detail page', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const memoryId = await seedOwnedMemory(seed.userB, PROMOTE_CONTENT);
    await signInThroughForm(page, seed.userB);
    await page.goto(`/memory/${memoryId}`);

    await page.getByTestId('promote-to-rule').click();
    await expect(page.getByTestId('promote-to-rule-done')).toBeVisible();

    // The promoted rule surfaces on /rules with the memory content as its
    // text (no prior candidate existed, so the promotion derived it).
    await page.goto('/rules?status=promoted');
    const item = page.getByTestId('rule-item').filter({ hasText: memoryId });
    await expect(item.getByTestId('rule-promoted')).toBeVisible();
    await expect(item.getByTestId('rule-text')).toContainText(
      PROMOTE_CONTENT.slice(0, 40)
    );
  });

  test('a dismissed candidacy is revived only by an explicit second click', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const candidate = await seedDismissedRuleCandidate(
      seed.userB,
      DISMISSED_FIXTURE
    );
    await signInThroughForm(page, seed.userB);
    await page.goto(`/memory/${candidate.memoryId}`);

    // The first click refuses and flips the button into its explicit
    // "promote anyway" arm instead of silently reviving the dismissal.
    await page.getByTestId('promote-to-rule').click();
    const force = page.getByTestId('promote-to-rule-force');
    await expect(force).toBeVisible();

    await force.click();
    await expect(page.getByTestId('promote-to-rule-done')).toBeVisible();

    await page.goto('/rules?status=promoted');
    const item = page
      .getByTestId('rule-item')
      .filter({ hasText: candidate.memoryId });
    await expect(item.getByTestId('rule-promoted')).toBeVisible();
  });
});
