/**
 * Browser-side helpers: UI login through the real form (the same path a
 * user takes), landing on the dashboard default page (the value dashboard),
 * and opening a tooltip that a too-early hover would lose.
 */
import { expect, type Locator, type Page } from '@playwright/test';

import type { E2EUser } from './users.js';

export const signInThroughForm = async (
  page: Page,
  user: E2EUser
): Promise<void> => {
  await page.goto('/login');
  await page.getByTestId('auth-login-email').fill(user.email);
  await page.getByTestId('auth-login-password').fill(user.password);
  await page.getByTestId('auth-login-submit').click();
  // Login lands on '/', which is now the value dashboard (insights).
  await expect(page.getByTestId('insights-page')).toBeVisible();
};

/**
 * Hovers `target` until the tooltip `hintTestId` opens, and answers it. A
 * hover that lands before a heavy page is interactive is lost — the pointer
 * then sits still over the target and nothing opens the tooltip — so each try
 * moves the pointer away first.
 */
export const hintOf = async (
  page: Page,
  target: Locator,
  hintTestId: string
): Promise<Locator> => {
  const tip = page.getByTestId(hintTestId);
  await expect(async () => {
    await page.mouse.move(0, 0);
    await target.hover();
    await expect(tip).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  return tip;
};

/** Opens the board's hint, the way `hintOf` opens any tooltip. */
export const openBoardHint = async (page: Page): Promise<void> => {
  await hintOf(page, page.getByTestId('board-hint'), 'board-hint-content');
};

/**
 * Waits for React to hydrate, not merely for the server's HTML to be on screen.
 *
 * An interaction that lands before hydration finds no handler attached: a
 * key press on the server's HTML does nothing. A screenshot taken then also
 * badges a hydration mismatch, as Playwright's injected caret style differs
 * from the server's markup.
 *
 * The signal is `next-themes` writing `style="color-scheme: …"` on <html>,
 * which the server-rendered markup never carries. A heading is NOT a signal: it
 * ships in the SSR HTML, so waiting on one can fire mid-hydration.
 */
export const waitForHydration = async (page: Page): Promise<void> => {
  await page.waitForFunction(() =>
    document.documentElement.getAttribute('style')?.includes('color-scheme')
  );
};
