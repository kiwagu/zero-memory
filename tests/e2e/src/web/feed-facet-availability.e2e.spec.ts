/**
 * The feed's filter facets follow the current selection: every value carries
 * how many memories it would yield under the other filters, and a value that
 * would yield nothing is greyed out instead of being offered as if it led
 * somewhere. Two invariants are the point of the design and are asserted here:
 * an empty value is DIMMED, never removed (removing it would reshuffle the list
 * on every choice), and the value the URL currently applies is never dimmed, so
 * it always stays possible to switch away from an empty view.
 *
 * Every view is narrowed by the shared marker, so the assertions hold whatever
 * else the stand's corpus contains.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const MARKER = 'e2e feed-facet marker';
const LIVE = `${MARKER}: the weekly digest is assembled on Sunday evening`;
const CLOSED = `${MARKER}: the migration rehearsal ran on the clone, nothing left to do`;

const feedUrl = (status?: string): string => {
  const query = new URLSearchParams({ q: MARKER });
  if (status) {
    query.set('status', status);
  }
  return `/memories?${query.toString()}`;
};

interface Written {
  memory_id: string;
}

/** Ids to remove after the file, so the feed's first page stays as it was. */
const seededMemories: string[] = [];

/**
 * One live decision plus one retired with nothing replacing it. Re-run safe:
 * the live row deduplicates to the same memory on every run, and the retired
 * ones only ever add to a bucket this spec never counts exactly.
 */
const seedFacetCorpus = async (token: string): Promise<void> => {
  const mcp = await McpTestClient.connect(token);
  try {
    const kept = await mcp.callTool('remember', {
      content: LIVE,
      kind: 'decision',
      scope: 'personal',
    });
    expect(kept.isError ?? false).toBe(false);
    seededMemories.push(firstJson<Written>(kept).memory_id);

    const closed = await mcp.callTool('remember', {
      content: CLOSED,
      kind: 'decision',
      scope: 'personal',
    });
    expect(closed.isError ?? false).toBe(false);
    const closedId = firstJson<Written>(closed).memory_id;
    seededMemories.push(closedId);
    const forgotten = await mcp.callTool('forget', { memory_id: closedId });
    expect(forgotten.isError ?? false).toBe(false);
  } finally {
    await mcp.close();
  }
};

test.describe('feed facet availability', () => {
  // These markers live in the DEFAULT feed view (the lone invalidation stays
  // visible by design), and other specs assert the seeded fixtures on page ONE
  // of the same feed — leaving them behind would push the fixtures off it.
  test.afterAll(async () => {
    if (seededMemories.length > 0) {
      await adminClient().from('memories').delete().in('id', seededMemories);
    }
  });

  test('@smoke a value that yields nothing is shown with its zero and dimmed', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedFacetCorpus(await passwordGrantToken(seed.userA));

    await signInThroughForm(page, seed.userA);
    await page.goto(feedUrl());

    // The kind facet is counted with the OTHER filters applied and its own
    // ignored, so every kind still reports what it would give.
    await page.getByTestId('feed-filter-kind').click();
    const decision = page.getByRole('option', { name: 'Decision' });
    await expect(decision).toBeVisible();
    await expect(decision).toHaveText(/\d+/);
    // No episode carries this marker: the option stays in the list, dimmed.
    const episode = page.getByRole('option', { name: 'Episode' });
    await expect(episode).toBeVisible();
    await expect(episode).toHaveAttribute('data-testid', 'facet-option-empty');
    await page.keyboard.press('Escape');

    // Same for the lifecycle statuses: this marker has no version history, so
    // "superseded" is the empty one, while the lone retirement is real.
    await page.getByTestId('feed-filter-status').click();
    await expect(
      page.getByRole('option', { name: 'Superseded versions' })
    ).toHaveAttribute('data-testid', 'facet-option-empty');
    const liveOnly = page.getByRole('option', { name: 'Live only' });
    await expect(liveOnly).not.toHaveAttribute(
      'data-testid',
      'facet-option-empty'
    );
    // Exactly one memory of this marker was never retired.
    await expect(liveOnly).toContainText('1');
  });

  test('"live only" drops the lone invalidation the default view keeps', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedFacetCorpus(await passwordGrantToken(seed.userA));

    await signInThroughForm(page, seed.userA);
    await page.goto(feedUrl());

    const feed = page.getByTestId('memory-feed');
    // The default view keeps both: a retirement without a successor stays
    // observable there.
    await expect(feed.getByText(LIVE.slice(0, 50)).first()).toBeVisible();
    await expect(feed.getByText(CLOSED.slice(0, 50)).first()).toBeVisible();

    await page.getByTestId('feed-filter-status').click();
    await page.getByRole('option', { name: 'Live only' }).click();
    await expect(page).toHaveURL(/status=live/);

    await expect(feed.getByText(LIVE.slice(0, 50)).first()).toBeVisible();
    await expect(feed.getByText(CLOSED.slice(0, 50))).toHaveCount(0);
  });

  test('an applied value stays usable even when it yields nothing', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedFacetCorpus(await passwordGrantToken(seed.userA));

    await signInThroughForm(page, seed.userA);
    // A view that is empty by construction: this marker has no version history.
    await page.goto(feedUrl('superseded'));
    await expect(
      page.getByTestId('memory-feed').getByTestId('memory-card')
    ).toHaveCount(0);

    // The applied value is NOT dimmed — otherwise the address bar and the
    // filter row would disagree and the view would be a dead end.
    await page.getByTestId('feed-filter-status').click();
    await expect(
      page.getByRole('option', { name: 'Superseded versions' })
    ).not.toHaveAttribute('data-testid', 'facet-option-empty');

    // And the way out still works: back to the default, which costs no param.
    await page.getByRole('option', { name: 'Active (no history)' }).click();
    await expect(page).toHaveURL(/\/memories\?q=e2e\+feed-facet\+marker$/);
    await expect(
      page.getByTestId('memory-feed').getByText(LIVE.slice(0, 50)).first()
    ).toBeVisible();
  });
});
