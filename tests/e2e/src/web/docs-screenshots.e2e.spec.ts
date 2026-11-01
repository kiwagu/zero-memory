/**
 * Documentation screenshots: the images the public docs pages ship, captured
 * from the live dashboard so a shipped picture can never drift from the shipped
 * UI. Not part of any gate — the `@docs-shot` tag keeps these out of the smoke
 * run; capture them on demand with `bun run e2e:screenshots`.
 *
 * Prepare the scene with `bun run demo:seed` first: this spec only photographs.
 * Seeding here would photograph `E2E fixture: …` rows instead of the product.
 *
 * Element shots where a doc page points at one panel, viewport shots where it
 * describes a whole screen. Never `fullPage` — a tall strip of a scrolled page
 * is unreadable at documentation width.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page } from '@playwright/test';

/** Where the documentation site serves its images from. */
const imageDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'apps',
  'docs',
  'public',
  'img'
);

const shotPath = (name: string): string => join(imageDir, `${name}.png`);

/**
 * Brings the shot's subject into frame: several screens open on something other
 * than what the doc page is about. `scrollIntoViewIfNeeded` moves nothing when
 * the subject is already visible, so this is safe everywhere.
 */
const frameOn = async (subject: Locator, page: Page): Promise<void> => {
  await subject.scrollIntoViewIfNeeded();
  await page.waitForTimeout(SETTLE_MS);
};

/**
 * Waits for React to hydrate, not merely for the server's HTML to be on screen.
 *
 * Playwright injects `caret-color: transparent` to hide the text caret; landing
 * before hydration, that attribute becomes a genuine hydration mismatch and the
 * `next dev` overlay badges the shot. Shoot after hydration instead.
 *
 * The signal is `next-themes` writing `style="color-scheme: …"` on <html>,
 * which the server-rendered markup never carries. A heading is NOT a signal: it
 * ships in the SSR HTML, so waiting on one can fire mid-hydration.
 */
const waitForHydration = async (page: Page): Promise<void> => {
  await page.waitForFunction(() =>
    document.documentElement.getAttribute('style')?.includes('color-scheme')
  );
};

/**
 * Drops the `next dev` devtools overlay from the frame. This hides TOOLING, not
 * an app defect: the badge is lit by this suite's own aborted requests.
 *
 * The config switch is not the answer, measured rather than assumed — the
 * stands already run `ZM_DEV_INDICATORS=off`, and Next 16's `devIndicators`
 * governs the BUILD indicator; the error badge is not reachable through it.
 */
const hideDevOverlay = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    document
      .querySelectorAll('nextjs-portal')
      .forEach((portal) => portal.remove());
  });
};

/** Writes one screen-level PNG, creating the docs image directory on first use. */
const captureScreen = async (page: Page, name: string): Promise<void> => {
  await mkdir(imageDir, { recursive: true });
  await waitForHydration(page);
  await hideDevOverlay(page);
  await page.screenshot({ path: shotPath(name) });
};

/**
 * Breathing room around a panel crop, in CSS pixels. An element screenshot
 * stops at the element's box, slicing off its border and shadow. Kept small: a
 * wide margin pulls in the neighbours the crop exists to exclude.
 */
const PANEL_PADDING = 10;

/** Writes one PNG of a single panel the doc page points at, with a margin. */
const capturePanel = async (
  target: Locator,
  name: string,
  page: Page
): Promise<void> => {
  await mkdir(imageDir, { recursive: true });
  // A panel crop is a screenshot too: same hydration and overlay gates.
  await waitForHydration(page);
  await hideDevOverlay(page);
  // The clip is in VIEWPORT coordinates, so a panel further down the page must
  // be scrolled into view or the region falls outside the image.
  await frameOn(target, page);
  const box = await target.boundingBox();
  if (!box) {
    throw new Error(`panel "${name}" has no box to capture`);
  }
  // Clamped at the origin: a panel flush against an edge would otherwise ask
  // for a negative offset, which Playwright rejects.
  const x = Math.max(0, box.x - PANEL_PADDING);
  const y = Math.max(0, box.y - PANEL_PADDING);
  await page.screenshot({
    path: shotPath(name),
    clip: {
      x,
      y,
      width: box.width + (box.x - x) + PANEL_PADDING,
      height: box.height + (box.y - y) + PANEL_PADDING,
    },
  });
};

/**
 * Pause after scrolling before the shutter: the dashboard's charts animate in,
 * and a capture taken mid-transition shows a half-drawn tile.
 */
const SETTLE_MS = 400;

/** The account the documentation is photographed against (see `demo:seed`). */
const SHOWCASE = { email: 'e2e@zm.local', password: 'zmreview' };

/** Signs in as the showcase account, failing with the fix when it is absent. */
const signIn = async (page: Page): Promise<void> => {
  await page.goto('/login');
  await page.getByTestId('auth-login-email').fill(SHOWCASE.email);
  await page.getByTestId('auth-login-password').fill(SHOWCASE.password);
  await page.getByTestId('auth-login-submit').click();
  await expect(
    page.getByTestId('insights-page'),
    'showcase account missing — run `bun run demo:seed` first'
  ).toBeVisible();
  // Let the landing page go quiet before the caller navigates on. Leaving with
  // a request in flight aborts it, and the dev server throws annotating the
  // resulting DOMException — an uncaught exception that lights the overlay's
  // error badge for the rest of the browser session. Hydration alone is not
  // enough: it completes while the dashboard's data requests still stream.
  await page.waitForLoadState('networkidle');
};

test.use({
  // 1097×549 at a 1.75 ratio, NOT the full size at ratio 1: the page lays out
  // as if the window were ~1100 wide — so text and controls fill the frame —
  // while the PNG still lands on 1920 real pixels wide. The height leaves room
  // for the chrome the documentation site draws (CHROME_HEIGHT in
  // apps/docs/components/screenshot.tsx, currently 119), so the two compose to
  // 1920×1080. Both numbers derive from one scale factor there; change it in
  // that file and mirror the viewport here.
  viewport: { width: 1097, height: 549 },
  deviceScaleFactor: 1.75,
});

test.describe('documentation screenshots', () => {
  test('@docs-shot memories landing screen', async ({ page }) => {
    await signIn(page);
    await page.goto('/memories');

    await expect(page.getByTestId('memory-card').first()).toBeVisible();
    await captureScreen(page, 'dashboard-overview');
  });

  test('@docs-shot memory card with its provenance badge', async ({ page }) => {
    await signIn(page);
    await page.goto('/memories');

    // The badge row ends with `author_kind · client`, and only a memory written
    // THROUGH a client carries one — the seed writes those over MCP.
    const card = page
      .getByTestId('memory-card')
      .filter({ hasText: 'agent ·' })
      .first();
    await expect(card).toBeVisible();
    await capturePanel(card, 'memory-card-provenance-badge', page);
  });

  test('@docs-shot memory card revealing its non-English original', async ({
    page,
  }) => {
    await signIn(page);
    // Filtered rather than taken off page one: the showcase corpus is longer
    // than a page, so the one memory with an original-language form would
    // otherwise depend on the feed's ordering.
    await page.goto('/memories?q=canonical+English');

    const card = page
      .getByTestId('memory-card')
      .filter({ has: page.getByTestId('memory-original-toggle') })
      .first();
    await expect(card).toBeVisible();
    await card.getByTestId('memory-original-toggle').click();
    await expect(card.getByTestId('memory-original-text')).toBeVisible();
    await capturePanel(card, 'memory-card-translate', page);
  });

  test('@docs-shot feed filtered to open loops', async ({ page }) => {
    await signIn(page);
    await page.goto('/memories?kind=task');

    // Both an open and a closed loop are on screen — closing is a reversible
    // invalidation, so the closed one stays in the feed, dimmed.
    const loops = page.getByTestId('memory-card');
    await expect(loops.first()).toBeVisible();
    await expect(loops.nth(1)).toBeVisible();
    await captureScreen(page, 'open-loops-feed-filter');
  });

  test('@docs-shot version history on a fact card', async ({ page }) => {
    await signIn(page);
    // Same reason as the original-language shot: filter to the memory that has
    // predecessors instead of hoping it lands on the first page.
    await page.goto('/memories?q=rate+limiter');

    const withHistory = page
      .getByTestId('memory-card')
      .filter({ has: page.getByTestId('memory-history-badge') })
      .first();
    await expect(withHistory).toBeVisible();
    // The card's content IS the link to its detail page.
    await withHistory.getByRole('link').first().click();

    const history = page.getByTestId('memory-version-history');
    await expect(history).toBeVisible();
    await capturePanel(history, 'memory-version-history', page);
  });

  test('@docs-shot rules incubator queue', async ({ page }) => {
    await signIn(page);
    await page.goto('/rules');

    const item = page.getByTestId('rule-item').first();
    await expect(item).toBeVisible();
    await expect(item.getByTestId('rule-text')).toBeVisible();
    await expect(item.getByTestId('rule-evidence')).toBeVisible();
    await frameOn(item, page);
    await captureScreen(page, 'rules-incubator-queue');
  });

  test('@docs-shot settings export and import panel', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings');

    const exportPanel = page.getByTestId('settings-export');
    await expect(exportPanel).toBeVisible();
    await expect(page.getByTestId('settings-export-button')).toBeVisible();
    await expect(page.getByTestId('settings-import')).toBeVisible();

    // The settings page opens on the profile panel, so the export panel this
    // shot is about sits below the fold — frame it at the top instead.
    await exportPanel.evaluate((node) =>
      node.scrollIntoView({ block: 'start', behavior: 'instant' })
    );
    await page.waitForTimeout(SETTLE_MS);
    await captureScreen(page, 'settings-export');
  });

  test('@docs-shot advanced search with ranked results', async ({ page }) => {
    await signIn(page);
    await page.goto('/memories');

    await page.getByTestId('advanced-search-toggle').click();
    await page
      .getByTestId('advanced-search-query')
      .fill('how does the store keep secrets out of memory?');
    await page.getByTestId('advanced-search-submit').click();

    const results = page.getByTestId('search-results');
    await expect(results).toBeVisible();
    await expect(results.getByTestId('memory-score').first()).toBeVisible();
    // The form fills the viewport on its own; the ranked results are the point.
    await frameOn(results, page);
    await captureScreen(page, 'dashboard-advanced-search');
  });

  test('@docs-shot insights overview', async ({ page }) => {
    await signIn(page);
    await page.goto('/');

    await expect(page.getByTestId('insights-page')).toBeVisible();
    const inventory = page.getByTestId('insights-inventory');
    await expect(inventory).toBeVisible();

    // Deliberately the viewport, not the whole scrollable page: a 2400px strip
    // is unreadable in a documentation column. The viewport's top is the hero
    // chart, so the shot is framed on the tiles the page is about.
    await inventory.evaluate((node) =>
      node.scrollIntoView({ block: 'start', behavior: 'instant' })
    );
    await page.waitForTimeout(SETTLE_MS);
    await captureScreen(page, 'dashboard-insights-overview');
  });

  test('@docs-shot how the corpus ages', async ({ page }) => {
    await signIn(page);
    await page.goto('/');

    const buckets = page.getByTestId('insights-age-buckets');
    await expect(buckets).toBeVisible();
    // The age section has no testid of its own: it is the one that holds the
    // bucket strip, alongside the faded-share and median-age tiles.
    const section = page
      .locator('section')
      .filter({ has: page.getByTestId('insights-age-buckets') });
    await expect(section.getByTestId('insights-metric-faded')).toBeVisible();
    await capturePanel(section, 'insights-how-it-ages', page);
  });

  test('@docs-shot roi benchmark tile', async ({ page }) => {
    await signIn(page);
    await page.goto('/');

    const roi = page.getByTestId('insights-metric-roi');
    await expect(roi).toBeVisible();
    await expect(roi).toContainText('%');
    await capturePanel(roi, 'roi-benchmark-tile', page);
  });

  test('@docs-shot memory activity log', async ({ page }) => {
    await signIn(page);
    await page.goto('/activity');

    await expect(page.getByTestId('activity-page')).toBeVisible();
    await expect(page.getByTestId('activity-row').first()).toBeVisible();
    await frameOn(page.getByTestId('activity-row').first(), page);
    await captureScreen(page, 'dashboard-insights-activity-log');
  });

  test('@docs-shot hygiene review queue', async ({ page }) => {
    await signIn(page);
    await page.goto('/review');

    const item = page.getByTestId('review-item').first();
    await expect(item).toBeVisible();
    await frameOn(item, page);
    await captureScreen(page, 'hygiene-review-queue');
  });

  test('@docs-shot reflections queue', async ({ page }) => {
    await signIn(page);
    await page.goto('/reflections');

    const card = page.getByTestId('reflection-candidate').first();
    await expect(card).toBeVisible();
    await expect(card.getByTestId('reflection-draft')).toBeVisible();
    await frameOn(card, page);
    await captureScreen(page, 'reflections-queue');
  });

  test('@docs-shot project board', async ({ page }) => {
    await signIn(page);
    // No scope in the address: the page opens on the board that moved last,
    // which is the seeded project's.
    await page.goto('/board');

    await expect(page.getByTestId('board')).toBeVisible();
    // The columns are one row that scrolls sideways at this width, so the
    // first ones are what the frame shows.
    await expect(
      page.getByTestId('board-column-active').getByTestId('board-card')
    ).toBeVisible();
    await captureScreen(page, 'project-board');
  });

  test('@docs-shot entities screen', async ({ page }) => {
    await signIn(page);
    await page.goto('/entities');

    // Neither the page nor the card carries a testid, so the heading and the
    // first entity name are what the shot waits on.
    await expect(
      page.getByRole('heading', { name: 'Entities', level: 1 })
    ).toBeVisible();
    await expect(page.getByText('zero-memory').first()).toBeVisible();
    await captureScreen(page, 'entities');
  });

  test('@docs-shot scopes screen', async ({ page }) => {
    await signIn(page);
    await page.goto('/scopes');

    await expect(
      page.getByRole('heading', { name: 'Scopes', level: 1 })
    ).toBeVisible();
    await captureScreen(page, 'scopes');
  });
});
