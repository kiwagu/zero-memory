/**
 * /rules shows what a session actually receives. The pinned and delivery
 * facets, the "Delivered N of M" badge and the delivery readers all use one
 * rule — pinned always, then the newest unpinned rules within the delivery
 * TTL up to the channel's cap — so a promoted rule a session never receives
 * is one click away instead of hiding behind a number. A rule that moved to
 * the successor of its memory, or still hangs on a retired one, says so.
 *
 * Runs as a user of its own, minted per attempt: the cap needs more than a
 * dozen promoted rules, which would shift every count the shared users'
 * specs assert on.
 */
import { expect, test, type Page } from '@playwright/test';

import { admin } from '../helpers/board-store.js';
import { seedOwnedMemory } from '../helpers/rules.js';
import { provisionE2EUser, type E2EUser } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

const DAY = 86_400_000;

interface Seeded {
  user: E2EUser;
  /** Rule text by role, for finding each one on the page. */
  text: Record<
    'pinned' | 'fresh0' | 'capped' | 'expired' | 'forgotten',
    string
  >;
}

/**
 * Fifteen promoted General rules for a fresh user: one pinned but past the
 * delivery TTL (still delivered), twelve recent unpinned ones (all delivered:
 * exactly the cap), one older unpinned one within the TTL (the thirteenth
 * newest, so capped), and one unpinned past the TTL. One of the recent ones
 * moved from an older memory keeping a curated text; another hangs on a
 * memory that was forgotten.
 */
const seedRules = async (): Promise<Seeded> => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const user = await provisionE2EUser(`e2e-rule-facets-${tag}@zm.e2e`);
  const client = admin();
  const now = Date.now();
  const text = {
    pinned: `facets ${tag}: pinned long ago`,
    fresh0: `facets ${tag}: fresh rule 0`,
    capped: `facets ${tag}: the thirteenth newest`,
    expired: `facets ${tag}: past the delivery TTL`,
    forgotten: `facets ${tag}: its memory was forgotten`,
  };

  const promote = async (
    ruleText: string,
    promotedDaysAgo: number,
    extra: Record<string, unknown> = {},
    memoryContent = `memory for ${ruleText}`
  ): Promise<string> => {
    const memoryId = await seedOwnedMemory(user, memoryContent);
    const { error } = await client.from('rule_candidates').insert({
      memory_id: memoryId,
      status: 'promoted',
      resolution: 'promoted',
      promoted_at: new Date(now - promotedDaysAgo * DAY).toISOString(),
      resolved_at: new Date(now).toISOString(),
      rule_text: ruleText,
      target_layer: 'user',
      useful_sessions: 0,
      window_days: 0,
      ...extra,
    });
    expect(error).toBeNull();
    return memoryId;
  };

  await promote(text.pinned, 200, { pinned: true });
  const previous = await seedOwnedMemory(
    user,
    `facets ${tag}: an older version`
  );
  await client
    .from('memories')
    .update({ invalidated_at: new Date(now).toISOString() })
    .eq('id', previous);
  await promote(text.fresh0, 0, {
    carried_from: previous,
    carried_at: new Date(now).toISOString(),
    text_review_since: new Date(now).toISOString(),
  });
  for (let i = 1; i <= 10; i += 1) {
    await promote(`facets ${tag}: fresh rule ${i}`, i);
  }
  const forgottenMemory = await promote(text.forgotten, 11);
  await client
    .from('memories')
    .update({ invalidated_at: new Date(now).toISOString() })
    .eq('id', forgottenMemory);
  await promote(text.capped, 30);
  await promote(text.expired, 120);
  return { user, text };
};

const item = (page: Page, ruleText: string) =>
  page.getByTestId('rule-item').filter({ hasText: ruleText });

test.describe('/rules delivery and pinned facets', () => {
  test('the facets and the badge agree with what a session receives, and live in the URL', async ({
    page,
  }) => {
    const { user, text } = await seedRules();
    await signInThroughForm(page, user);

    await page.goto('/rules?status=promoted');
    // 15 promoted General rules; the pinned one and the 12 newest reach a
    // session, the capped one and the expired one do not.
    const badge = page.getByTestId('rules-delivered-count');
    await expect(badge).toContainText('13');
    await expect(badge).toContainText('15');

    // The amber badge opens what is NOT delivered.
    await page.getByTestId('rules-delivered-link').click();
    await expect(page).toHaveURL(/delivery=undelivered/);
    await expect(page.getByTestId('rule-item')).toHaveCount(2);
    await expect(item(page, text.capped)).toHaveCount(1);
    await expect(item(page, text.expired)).toHaveCount(1);

    await page.goto('/rules?status=promoted&delivery=delivered');
    await expect(page.getByTestId('rule-item')).toHaveCount(13);
    await expect(item(page, text.pinned)).toHaveCount(1);
    await expect(item(page, text.capped)).toHaveCount(0);
    await expect(item(page, text.expired)).toHaveCount(0);

    // The pinned badge opens the pinned rules.
    await page.goto('/rules?status=promoted');
    await page.getByTestId('rules-pinned-link').click();
    await expect(page).toHaveURL(/pinned=pinned/);
    await expect(page.getByTestId('rule-item')).toHaveCount(1);
    await expect(item(page, text.pinned)).toHaveCount(1);

    // Both facets together survive a reload, and clearing one leaves the other.
    await page.goto(
      '/rules?status=promoted&pinned=unpinned&delivery=undelivered'
    );
    await expect(page.getByTestId('rule-item')).toHaveCount(2);
    await page.reload();
    await expect(page.getByTestId('rule-item')).toHaveCount(2);

    // Back to "any": the parameter leaves the address.
    await page.getByTestId('rules-filter-delivery').click();
    await page.getByRole('option', { name: 'Delivered or not' }).click();
    await expect(page).not.toHaveURL(/delivery=/);
    await expect(page).toHaveURL(/pinned=unpinned/);
    await expect(page.getByTestId('rule-item')).toHaveCount(14);
    await expect(item(page, text.pinned)).toHaveCount(0);
  });

  test('a rule says when it moved, and when its memory is gone', async ({
    page,
  }) => {
    const { user, text } = await seedRules();
    await signInThroughForm(page, user);
    await page.goto('/rules?status=promoted');

    const moved = item(page, text.fresh0);
    await expect(moved.getByTestId('rule-review-signal')).toBeVisible();
    await expect(moved.getByTestId('rule-carried-from')).toBeVisible();
    await expect(moved.getByTestId('rule-source-signal')).toHaveCount(0);

    const orphan = item(page, text.forgotten);
    await expect(orphan.getByTestId('rule-source-signal')).toContainText(
      'forgotten'
    );
    await expect(orphan.getByTestId('rule-review-signal')).toHaveCount(0);
  });
});
