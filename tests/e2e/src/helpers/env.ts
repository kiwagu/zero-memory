/**
 * Resolved e2e environment. Values come from tests/e2e/.env with the repo
 * root .env as fallback (loaded in playwright.config.ts); the defaults below
 * match the local dev stack (`bun dev` + `bunx supabase start`).
 */

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing env ${name} — run \`bun scripts/seed-env.ts\` or create tests/e2e/.env`
    );
  }
  return value;
};

export const e2eEnv = {
  /**
   * MCP/OAuth server base URL, no trailing slash. The default is the TEST
   * contour (:8788), never the dev/stage server (:8787): a bare
   * `bunx playwright test` without the harness env must hit the isolated
   * stack — with the old :8787 default it silently provisioned users and
   * wrote fixture memories into the LIVE database. Point at another stack
   * explicitly via E2E_SERVER_URL (`bun run pw` does).
   */
  serverUrl: (process.env.E2E_SERVER_URL ?? 'http://localhost:8788').replace(
    /\/$/,
    ''
  ),
  /** Dashboard base URL (test contour by default, see serverUrl). */
  webUrl: (process.env.E2E_WEB_URL ?? 'http://localhost:3102').replace(
    /\/$/,
    ''
  ),
  get supabaseUrl(): string {
    return required('SUPABASE_URL');
  },
  get supabaseAnonKey(): string {
    return required('SUPABASE_ANON_KEY');
  },
  get supabaseServiceRoleKey(): string {
    return required('SUPABASE_SERVICE_ROLE_KEY');
  },
  userAEmail: process.env.E2E_USER_A_EMAIL ?? 'e2e-a@zm.e2e',
  userBEmail: process.env.E2E_USER_B_EMAIL ?? 'e2e-b@zm.e2e',
  password: process.env.E2E_PASSWORD ?? 'e2e-zero-memory',
  /** Requests per window the server's OAuth rate limiter allows. */
  rateLimitMax: Number.parseInt(process.env.E2E_RATELIMIT_MAX ?? '30', 10),
};
