import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

// Local overrides first (tests/e2e/.env), then the repo root .env seeded by
// `bun scripts/seed-env.ts` as the fallback — dotenv never overwrites vars
// that are already set, so the more specific file wins.
loadEnv({ path: '.env', quiet: true });
loadEnv({ path: '../../.env', quiet: true });

const webUrl = process.env.E2E_WEB_URL ?? 'http://localhost:3102';

export default defineConfig({
  testDir: './src',
  testMatch: '**/*.e2e.spec.ts',
  globalSetup: './src/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Two workers max in dev: the shared Next.js dev server is single-threaded
  // and times out on SSR/auth under higher concurrency.
  workers: process.env.CI ? 1 : 2,
  // Non-interactive by default: `line` under CI (the turbo test tasks set
  // CI=1), and an `html` report that is written but never auto-served, so a
  // run never blocks trying to open a browser/report server.
  reporter: process.env.CI ? 'line' : [['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      // Protocol layer: OAuth surface, MCP over HTTP, RLS visibility.
      // Pure request-context specs — no browser is ever launched.
      name: 'api',
      testMatch: 'api/**/*.e2e.spec.ts',
    },
    {
      // Browser layer: the dashboard as the user sees it (login, feed, card).
      name: 'web',
      testMatch: 'web/**/*.e2e.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        baseURL: webUrl,
      },
    },
  ],
});
