/**
 * Rules-incubator review surface: the owner sees a distilled candidate with
 * its evidence, approving turns it into a copy/download block (and counts as
 * promoted), dismissing clears it, and the queue is owner-scoped. Each spec
 * seeds its own candidate so order and retries never matter.
 */
import { expect, test } from '@playwright/test';

import {
  SUGGESTED_SIBLING_SCOPE,
  seedPromotedRuleCandidate,
  seedRuleCandidate,
} from '../helpers/rules.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('rules incubator surface', () => {
  test('@smoke owner sees a pending candidate with draft and evidence', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const candidate = await seedRuleCandidate(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/rules');

    const item = page.getByTestId('rule-item').first();
    await expect(item).toBeVisible();
    await expect(item.getByTestId('rule-text')).toContainText(
      candidate.ruleText.slice(0, 40)
    );
    // Evidence: session count + link back to the source memory.
    await expect(item.getByTestId('rule-evidence')).toContainText('4');
    await expect(item.getByTestId('rule-memory-link')).toContainText(
      candidate.memoryId
    );
    // The source memory's scope is shown as the rule's suggested home.
    await expect(item.getByTestId('rule-scope')).toBeVisible();
  });

  test('approving promotes the candidate into a copy/download block', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const candidate = await seedRuleCandidate(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/rules');

    await expect(page.getByTestId('rule-approve').first()).toBeVisible();
    await page.getByTestId('rule-approve').first().click();

    // The pending queue empties; the artifact lives under the promoted
    // status filter now.
    await expect(page.getByTestId('rules-empty')).toBeVisible();
    await page.goto('/rules?status=promoted');
    const promoted = page.getByTestId('rule-item').first();
    await expect(promoted.getByTestId('rule-promoted')).toBeVisible();
    await expect(promoted.getByTestId('rule-copy')).toBeVisible();
    void candidate;
  });

  test('download dropdown hands over the rule shaped for each environment', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedPromotedRuleCandidate(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/rules?status=promoted');

    const promoted = page.getByTestId('rule-item').first();
    await expect(promoted.getByTestId('rule-download')).toBeVisible();

    // Cursor → a .mdc file (the format-specific extension proves the routing).
    await promoted.getByTestId('rule-download').click();
    const cursorDownload = page.waitForEvent('download');
    await page.getByTestId('rule-download-cursor').click();
    expect((await cursorDownload).suggestedFilename()).toMatch(/\.mdc$/);

    // Codex → an AGENTS.md file.
    await promoted.getByTestId('rule-download').click();
    const codexDownload = page.waitForEvent('download');
    await page.getByTestId('rule-download-codex').click();
    expect((await codexDownload).suggestedFilename()).toMatch(/\.AGENTS\.md$/);
  });

  test('pinning a promoted General rule toggles placement and the counter', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedPromotedRuleCandidate(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/rules?status=promoted');

    // A promoted General rule offers the pin switch, off by default.
    const toggle = page.getByTestId('rule-pin-toggle').first();
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId('rules-pinned-count')).toHaveCount(0);

    // Pin: the switch flips on and the header counts the pinned subset.
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.getByTestId('rules-pinned-count')).toContainText('1');

    // Unpin: back to the unpinned baseline.
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId('rules-pinned-count')).toHaveCount(0);
  });

  test('revoking a promoted rule needs a reason and clears it from active', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedPromotedRuleCandidate(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/rules?status=promoted');

    await page.getByTestId('rule-revoke').first().click();
    // Reason is required: submit stays disabled until the field is filled.
    const submit = page.getByTestId('rule-revoke-submit');
    await expect(submit).toBeDisabled();
    await page
      .getByTestId('rule-revoke-reason')
      .fill('Superseded by a broader rule.');
    await expect(submit).toBeEnabled();
    await submit.click();

    // The rule leaves the active (promoted) list → the page shows no items.
    await expect(page.getByTestId('rules-empty')).toBeVisible();
    await expect(page.getByTestId('rule-item')).toHaveCount(0);
  });

  test('scope recommendation chips surface and drive the queue filter', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedRuleCandidate(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/rules');

    // Ranked chips: deterministic origin + the speculative sibling guess.
    const item = page.getByTestId('rule-item').first();
    await expect(item.getByTestId('rule-applies-to')).toBeVisible();
    await expect(item.getByTestId('rule-scope-llm')).toContainText(
      SUGGESTED_SIBLING_SCOPE
    );

    // Filtering by a SUGGESTED scope still surfaces the rule…
    await page.goto(
      `/rules?scope=${encodeURIComponent(SUGGESTED_SIBLING_SCOPE)}`
    );
    await expect(page.getByTestId('rule-item').first()).toBeVisible();

    // …while an unrelated scope shows an empty queue.
    await page.goto('/rules?scope=proj.absent');
    await expect(page.getByTestId('rules-empty')).toBeVisible();
  });

  test('dismissing clears the queue; the dismissed row can be deleted', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedRuleCandidate(seed.userA);
    await signInThroughForm(page, seed.userA);
    await page.goto('/rules');

    await expect(page.getByTestId('rule-item').first()).toBeVisible();
    await page.getByTestId('rule-dismiss').first().click();
    await expect(page.getByTestId('rules-empty')).toBeVisible();

    // The dismissal is visible under its status filter and deletable there.
    await page.goto('/rules?status=dismissed');
    const dismissed = page.getByTestId('rule-item').first();
    await expect(dismissed.getByTestId('rule-dismissed')).toBeVisible();
    await dismissed.getByTestId('rule-delete').click();
    // ConfirmDialog: the destructive confirm carries the delete label.
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(page.getByTestId('rules-empty')).toBeVisible();
    await expect(page.getByTestId('rule-item')).toHaveCount(0);
  });

  test('@smoke a non-owner sees no candidates (owner-scoped queue)', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedRuleCandidate(seed.userA); // A owns a candidate…
    await signInThroughForm(page, seed.userB); // …B must not see it.
    await page.goto('/rules');

    await expect(page.getByTestId('rules-empty')).toBeVisible();
  });
});
