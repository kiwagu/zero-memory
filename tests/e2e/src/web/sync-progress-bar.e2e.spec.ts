/**
 * The global sync bar: one thin bar at the top of the page while it waits on
 * the server, wired to no call site.
 *
 * Worth an e2e rather than only the unit tests of its parts, because what makes
 * it work is the real App Router sending its requests through the page's
 * `fetch`. A unit test cannot show that a server action, the refresh after it
 * and a navigation all reach the one wrapper, nor that a fast request stays
 * invisible in a real browser.
 *
 * A dedicated account: a write by another spec would nudge this one's pages
 * over Realtime into a refresh, and that refresh may legitimately light the
 * bar in the middle of the "fast request" check.
 */
import { expect, test, type Page, type Request } from '@playwright/test';

import { provisionE2EUser } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

const BAR = 'sync-progress-bar';
/** Far above the bar's 200 ms delay, far below the assertion timeout. */
const SLOW_MS = 1500;

/** Holds every request `matches` selects for SLOW_MS, then lets it through. */
const slowDown = (page: Page, matches: (request: Request) => boolean) =>
  page.route('**/*', async (route) => {
    if (matches(route.request())) {
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    }
    await route.continue();
  });

const signIn = async (page: Page) =>
  signInThroughForm(page, await provisionE2EUser('sync-bar@zm.e2e'));

test.describe('the global sync bar', () => {
  test('a slow server action shows the bar until the page has updated', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/settings');
    await slowDown(
      page,
      (request) =>
        request.method() === 'POST' &&
        request.headers()['next-action'] !== undefined
    );

    await page.getByTestId('profile-name').fill('Sync Bar Probe');
    await page.getByTestId('profile-save').click();

    const bar = page.getByTestId(BAR);
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('role', 'progressbar');
    await expect(bar).toHaveAttribute('aria-label', 'Syncing with the server');
    // The save lands, its refresh re-renders the page, and only then the bar
    // goes: it waits for the work, not for a timer.
    await expect(page.getByTestId('profile-saved')).toBeVisible();
    await expect(bar).toBeHidden();
  });

  test('a slow navigation shows the bar, and it leaves once the next page is in', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/memories');
    await expect(page.getByTestId('memory-feed')).toBeVisible();
    // The page payload of a navigation, not a background prefetch.
    await slowDown(
      page,
      (request) =>
        request.headers()['rsc'] === '1' &&
        request.headers()['next-router-prefetch'] === undefined
    );

    await page.getByRole('link', { name: 'Entities' }).click();

    const bar = page.getByTestId(BAR);
    await expect(bar).toBeVisible();
    await expect(page).toHaveURL(/\/entities$/u);
    await expect(bar).toBeHidden();
  });

  test('a request faster than the delay never shows the bar', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/memories');
    await expect(page.getByTestId('memory-feed')).toBeVisible();

    // Record whether the bar is EVER attached, not just whether it is there
    // at the moment of a check.
    await page.evaluate(() => {
      const probe = window as unknown as { syncBarSeen: boolean };
      probe.syncBarSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="sync-progress-bar"]')) {
          probe.syncBarSeen = true;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.evaluate(async () => {
      await (await fetch('/healthz')).text();
    });
    // Past the delay and the minimum time the bar would have stayed.
    await page.waitForTimeout(800);
    expect(
      await page.evaluate(
        () => (window as unknown as { syncBarSeen: boolean }).syncBarSeen
      )
    ).toBe(false);

    // The same request, slowed down, does show it: the check above was
    // watching a bar that is really there.
    await slowDown(page, (request) => request.url().endsWith('/healthz'));
    await page.evaluate(() => {
      void fetch('/healthz');
    });
    await expect(page.getByTestId(BAR)).toBeVisible();
    await expect(page.getByTestId(BAR)).toBeHidden();
  });
});
