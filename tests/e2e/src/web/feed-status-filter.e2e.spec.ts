/**
 * The feed's lifecycle-status filter: the default view drops HISTORICAL
 * versions (retired with a successor) while keeping LONE invalidations
 * (retired with nothing replacing them) visible — the only observable trace of
 * a deliberate cleanup or a false invalidation. Both are reachable through the
 * status filter, and the successor still advertises its chain.
 *
 * Every view is narrowed by the shared marker so the assertions hold whatever
 * else the stand's corpus contains (the feed paginates).
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

const MARKER = 'e2e feed-status marker';
const OLD = `${MARKER}: the export bundle keeps 7 daily snapshots`;
const NEW = `${MARKER}: the export bundle keeps 30 daily snapshots after the retention review`;
const LONE = `${MARKER}: the nightly digest ships at 06:00 UTC, retired without a replacement`;

/** The feed, narrowed to this spec's memories, under a given status. */
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

/**
 * A fresh supersession chain plus a lone invalidation, written the way an agent
 * writes them (a declared supersede on write, then a forget). Re-run safe: the
 * near-duplicate probe ignores retired rows, so a previous run's rows are never
 * revived or re-linked.
 */
const seedLifecycle = async (token: string): Promise<void> => {
  const mcp = await McpTestClient.connect(token);
  try {
    const older = await mcp.callTool('remember', {
      content: OLD,
      kind: 'decision',
      scope: 'personal',
    });
    expect(older.isError ?? false).toBe(false);
    const oldId = firstJson<Written>(older).memory_id;

    const newer = await mcp.callTool('remember', {
      content: NEW,
      kind: 'decision',
      links: [{ dst: oldId, type: 'supersedes' }],
      scope: 'personal',
    });
    expect(newer.isError ?? false).toBe(false);
    expect(firstJson<Written>(newer).memory_id).not.toBe(oldId);

    const lone = await mcp.callTool('remember', {
      content: LONE,
      kind: 'fact',
      scope: 'personal',
    });
    expect(lone.isError ?? false).toBe(false);
    const forgotten = await mcp.callTool('forget', {
      memory_id: firstJson<Written>(lone).memory_id,
    });
    expect(forgotten.isError ?? false).toBe(false);
  } finally {
    await mcp.close();
  }
};

test.describe('feed status filter', () => {
  test('@smoke the default feed hides history but keeps a lone invalidation', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedLifecycle(await passwordGrantToken(seed.userA));

    await signInThroughForm(page, seed.userA);
    await page.goto(feedUrl());

    const feed = page.getByTestId('memory-feed');
    // The successor is live and advertises the chain it heads.
    const successor = feed
      .getByTestId('memory-card')
      .filter({ hasText: NEW.slice(0, 50) })
      .first();
    await expect(successor).toBeVisible();
    await expect(successor.getByTestId('memory-history-badge')).toBeVisible();

    // The version it replaced is gone from the default view…
    await expect(feed.getByText(OLD.slice(0, 50))).toHaveCount(0);

    // …while the memory retired with NOTHING replacing it stays, badged — a
    // false invalidation must not be able to hide behind version history.
    const retired = feed
      .getByTestId('memory-card')
      .filter({ hasText: LONE.slice(0, 50) })
      .first();
    await expect(retired).toBeVisible();
    await expect(retired.getByTestId('memory-invalidated-badge')).toBeVisible();
    await expect(retired.getByTestId('memory-history-badge')).toHaveCount(0);

    // Getting the default view costs no param: it is the bare feed.
    expect(page.url()).not.toContain('status=');
  });

  test('the superseded filter shows exactly the hidden version', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedLifecycle(await passwordGrantToken(seed.userA));

    await signInThroughForm(page, seed.userA);
    await page.goto(feedUrl('superseded'));

    const feed = page.getByTestId('memory-feed');
    await expect(feed.getByText(OLD.slice(0, 50)).first()).toBeVisible();
    // Neither the live successor nor the lone retirement is version history.
    await expect(feed.getByText(NEW.slice(0, 50))).toHaveCount(0);
    await expect(feed.getByText(LONE.slice(0, 50))).toHaveCount(0);
  });

  test('the invalidated filter shows the lone retirement, not the versions', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedLifecycle(await passwordGrantToken(seed.userA));

    await signInThroughForm(page, seed.userA);
    await page.goto(feedUrl('invalidated'));

    const feed = page.getByTestId('memory-feed');
    await expect(feed.getByText(LONE.slice(0, 50)).first()).toBeVisible();
    await expect(feed.getByText(OLD.slice(0, 50))).toHaveCount(0);
    await expect(feed.getByText(NEW.slice(0, 50))).toHaveCount(0);
  });

  test('the filter row drives the status, and the default leaves no param', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await seedLifecycle(await passwordGrantToken(seed.userA));

    await signInThroughForm(page, seed.userA);
    await page.goto(feedUrl());

    await page.getByTestId('feed-filter-status').click();
    await page.getByRole('option', { name: 'Superseded versions' }).click();
    await expect(page).toHaveURL(/status=superseded/);
    await expect(
      page.getByTestId('memory-feed').getByText(OLD.slice(0, 50)).first()
    ).toBeVisible();

    // Back to the default: the status param leaves the URL entirely (the other
    // filters stay), and the live view comes back.
    await page.getByTestId('feed-filter-status').click();
    await page.getByRole('option', { name: 'Active (no history)' }).click();
    await expect(page).toHaveURL(/\/memories\?q=e2e\+feed-status\+marker$/);
    await expect(
      page.getByTestId('memory-feed').getByText(NEW.slice(0, 50)).first()
    ).toBeVisible();
  });
});
