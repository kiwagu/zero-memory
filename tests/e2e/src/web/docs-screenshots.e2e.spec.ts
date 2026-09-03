/**
 * Documentation screenshots: the images the public docs pages ship, captured
 * from the live dashboard so a shipped picture can never drift from the shipped
 * UI. Not part of any gate — the `@docs-shot` tag keeps these out of the smoke
 * run; capture them on demand with `bun run e2e:screenshots`.
 *
 * THIS SPEC ONLY PHOTOGRAPHS. The scene is prepared by `bun run demo:seed`,
 * which fills the showcase account with real, curated content (see
 * `scripts/curate-showcase.ts`). Seeding here as well would photograph
 * `E2E fixture: …` rows — a picture of the test harness rather than of the
 * product. Run the seed first; every test below fails with that instruction if
 * the account is missing.
 *
 * Element shots are used where a doc page points at one panel, viewport shots
 * where it describes a whole screen. Nothing is captured `fullPage`: a tall
 * strip of a scrolled page is unreadable at documentation width.
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
 * Brings the shot's SUBJECT into frame before the shutter.
 *
 * Several screens open on something other than what the doc page is about — the
 * settings page starts at the profile panel, the insights page at its hero
 * chart, the search screen at its form. Capturing the raw viewport then shows
 * everything except the point. `scrollIntoViewIfNeeded` moves nothing when the
 * subject is already visible, so this is safe to apply everywhere.
 */
const frameOn = async (subject: Locator, page: Page): Promise<void> => {
  await subject.scrollIntoViewIfNeeded();
  await page.waitForTimeout(SETTLE_MS);
};

/** Writes one screen-level PNG, creating the docs image directory on first use. */
const captureScreen = async (page: Page, name: string): Promise<void> => {
  await mkdir(imageDir, { recursive: true });
  await page.screenshot({ path: shotPath(name) });
};

/**
 * Breathing room around a panel crop, in CSS pixels.
 *
 * An element screenshot stops exactly at the element's box, which slices off
 * the very thing that makes a tile look like a tile: its border and the shadow
 * just outside it. Capturing a slightly larger region keeps the card intact.
 * Kept small on purpose — a wide margin starts pulling in the neighbours a
 * crop exists to exclude.
 */
const PANEL_PADDING = 10;

/** Writes one PNG of a single panel the doc page points at, with a margin. */
const capturePanel = async (
  target: Locator,
  name: string,
  page: Page
): Promise<void> => {
  await mkdir(imageDir, { recursive: true });
  // The clip is expressed in VIEWPORT coordinates, so a panel further down a
  // long page must be scrolled into view first — otherwise the requested
  // region falls outside the image and the capture fails.
  await frameOn(target, page);
  const box = await target.boundingBox();
  if (!box) {
    throw new Error(`panel "${name}" has no box to capture`);
  }
  // Clamped at the page origin: a panel flush against the top or left edge
  // would otherwise ask for a negative offset, which Playwright rejects.
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
    // than a page, and the one memory with an original-language form would
    // otherwise depend on where the feed's ordering happened to put it.
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

    // Deliberately the viewport, not the whole scrollable page: a 2400px-tall
    // strip is unreadable once scaled into a documentation column. But the
    // viewport's TOP is the hero chart, which says little on its own — so the
    // shot is framed on the tiles the page is actually about.
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

  test.describe('dark theme', () => {
    // The theme is `next-themes` in system mode, so the emulated colour scheme
    // is what flips the dashboard — no toggle to drive.
    test.use({ colorScheme: 'dark' });

    test('@docs-shot memory feed in dark theme', async ({ page }) => {
      await signIn(page);
      await page.goto('/memories');

      await expect(page.getByTestId('memory-card').first()).toBeVisible();
      await captureScreen(page, 'dashboard-dark-theme');
    });
  });
});
