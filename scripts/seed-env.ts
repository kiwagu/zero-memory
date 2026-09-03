/**
 * Seeds local .env files for every app so the whole stack boots with `bun dev`.
 *
 * What it does, idempotently:
 *   1. Ensures the local Supabase stack is running (`bunx supabase start`).
 *   2. Reads its URL/keys from `bunx supabase status -o env`.
 *   3. Writes .env files (root, apps/server, apps/watcher) and apps/web/.env.local.
 *      Existing files are left untouched unless --force is passed.
 *   4. Provisions the dev user (ZM_EMAIL/ZM_PASSWORD) and syncs its password.
 *
 * Usage: bun scripts/seed-env.ts [--force]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';

const root = resolve(import.meta.dir, '..');
const force = process.argv.includes('--force');

const DEFAULT_DEV_EMAIL = 'dev@zero-memory.local';
const ZM_EMAIL = process.env.ZM_EMAIL ?? DEFAULT_DEV_EMAIL;
const ZM_PASSWORD = process.env.ZM_PASSWORD ?? 'zero-memory-dev';
const SERVER_PORT = process.env.PORT ?? '8787';

// Preserve an existing value from the root .env across reseeds. Used for the
// Anthropic key (extractor) and for ZM_PUBLIC_URL — the OAuth issuer, which the
// operator may have pointed at a LAN name (e.g. http://my-box.lan:8787). Empty
// string when absent.
function readExistingKey(
  name: string,
  envPath = resolve(root, '.env')
): string {
  if (process.env[name]) return process.env[name]!;
  if (!existsSync(envPath)) return '';
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(
    readFileSync(envPath, 'utf8')
  );
  return match?.[1] ?? '';
}
const ANTHROPIC_API_KEY = readExistingKey('ANTHROPIC_API_KEY');
// Server runtime posture that must reach apps/server (Bun cwd gotcha, mirrored below).
const ZM_INGEST_EXTRACT = readExistingKey('ZM_INGEST_EXTRACT');
const PUBLIC_URL =
  process.env.ZM_PUBLIC_URL ??
  (readExistingKey('ZM_PUBLIC_URL') || `http://localhost:${SERVER_PORT}`);

function supabase(args: string[]): { ok: boolean; stdout: string } {
  const res = spawnSync('bunx', ['supabase', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: res.status === 0, stdout: res.stdout ?? '' };
}

function statusEnv(): Map<string, string> | null {
  const res = supabase(['status', '-o', 'env']);
  if (!res.ok) return null;
  const map = new Map<string, string>();
  for (const line of res.stdout.split('\n')) {
    const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) map.set(m[1], m[2]);
  }
  return map.has('ANON_KEY') ? map : null;
}

console.log('→ checking local Supabase stack…');
let env = statusEnv();
if (!env) {
  console.log('→ stack is down, starting it (this can take a while)…');
  const started = supabase(['start']);
  if (!started.ok) {
    console.error(
      'Failed to start the Supabase stack. Run `bunx supabase start` manually.'
    );
    process.exit(1);
  }
  env = statusEnv();
}
if (!env) {
  console.error('Could not read `supabase status` output.');
  process.exit(1);
}

const apiUrl = env.get('API_URL') ?? 'http://127.0.0.1:55321';
const anonKey = env.get('ANON_KEY');
const serviceRoleKey = env.get('SERVICE_ROLE_KEY');
if (!anonKey || !serviceRoleKey) {
  console.error('supabase status did not expose ANON_KEY/SERVICE_ROLE_KEY.');
  process.exit(1);
}

// The browser bakes NEXT_PUBLIC_SUPABASE_URL into the web bundle and calls it
// directly, so it must be reachable FROM THE BROWSER — `apiUrl` (127.0.0.1) only
// works when the browser runs on the server host. For LAN access set
// ZM_SUPABASE_PUBLIC_URL (e.g. http://my-box.lan:55321); preserved across reseeds.
const WEB_SUPABASE_URL =
  process.env.ZM_SUPABASE_PUBLIC_URL ??
  (readExistingKey(
    'NEXT_PUBLIC_SUPABASE_URL',
    resolve(root, 'apps/web/.env.local')
  ) ||
    apiUrl);

// The root file deliberately carries NO ZM_SERVER_URL. Bun loads `.env` from
// the CWD, so a value here would silently become the server for anything run
// from the repo root — including an editor hook whose cwd is this project —
// overriding the one place that answer belongs (~/.config/zero-memory/
// config.json, or a deliberate export). Only the watcher's own dev run gets a
// target, in its own package file below.
const files: Array<{ path: string; content: string }> = [
  {
    path: resolve(root, '.env'),
    content: [
      `SUPABASE_URL=${apiUrl}`,
      `SUPABASE_ANON_KEY=${anonKey}`,
      `SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`,
      `ZM_EMAIL=${ZM_EMAIL}`,
      `ZM_PASSWORD=${ZM_PASSWORD}`,
      `ZM_PUBLIC_URL=${PUBLIC_URL}`,
      `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}`,
      '',
    ].join('\n'),
  },
  {
    path: resolve(root, 'apps/server/.env'),
    content: [
      `PORT=${SERVER_PORT}`,
      `ZM_PUBLIC_URL=${PUBLIC_URL}`,
      `SUPABASE_URL=${apiUrl}`,
      `SUPABASE_ANON_KEY=${anonKey}`,
      `SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`,
      `ZM_EMAIL=${ZM_EMAIL}`,
      `ZM_PASSWORD=${ZM_PASSWORD}`,
      `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}`,
      '',
    ].join('\n'),
  },
  {
    path: resolve(root, 'apps/web/.env.local'),
    content: [
      `NEXT_PUBLIC_SUPABASE_URL=${WEB_SUPABASE_URL}`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}`,
      `SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`,
      '',
    ].join('\n'),
  },
  {
    // The watcher authenticates over OAuth (see @workspace/mcp-oauth-client),
    // so it needs only the server URL — no Supabase creds.
    path: resolve(root, 'apps/watcher/.env'),
    content: [`ZM_SERVER_URL=${PUBLIC_URL}/mcp`, ''].join('\n'),
  },
];

for (const file of files) {
  if (existsSync(file.path) && !force) {
    console.log(`· ${file.path} exists — kept (use --force to overwrite)`);
    continue;
  }
  writeFileSync(file.path, file.content);
  console.log(`✓ wrote ${file.path}`);
}

// Turbo runs each app with its own directory as the cwd, and Bun auto-loads
// .env only from the cwd — never the repo root. So a per-app runtime value
// pasted into the root .env would be invisible to apps/server. Keep the root
// .env the single source of truth by mirroring these keys into the app .env on
// every run (even without --force), so `bun dev`/`bun start` stays self-healing.
function syncKey(name: string, value: string, target: string): void {
  if (!existsSync(target)) return;
  const desired = `${name}=${value}`;
  const current = readFileSync(target, 'utf8');
  const line = new RegExp(`^${name}=.*$`, 'm');
  const next = line.test(current)
    ? current.replace(line, desired)
    : `${current.replace(/\n?$/, '\n')}${desired}\n`;
  if (next !== current) {
    writeFileSync(target, next);
    console.log(`↻ synced ${name} into ${target}`);
  }
}
const serverEnv = resolve(root, 'apps/server/.env');
if (ANTHROPIC_API_KEY) {
  syncKey('ANTHROPIC_API_KEY', ANTHROPIC_API_KEY, serverEnv);
}
// ZM_INGEST_EXTRACT=off is the metrics-only posture; the server (apps/server)
// reads it, so it must land there, not just in the root .env.
if (ZM_INGEST_EXTRACT) {
  syncKey('ZM_INGEST_EXTRACT', ZM_INGEST_EXTRACT, serverEnv);
}

console.log(`→ provisioning dev user ${ZM_EMAIL}…`);
const admin = createClient(apiUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const created = await admin.auth.admin.createUser({
  email: ZM_EMAIL,
  password: ZM_PASSWORD,
  email_confirm: true,
});

if (created.error) {
  if (created.error.code !== 'email_exists') {
    console.error(`Failed to create user: ${created.error.message}`);
    process.exit(1);
  }
  // Only the throwaway default dev account gets its password force-synced to
  // ZM_PASSWORD. A custom account (a real login the user manages) is left
  // untouched — resetting it here would clobber the user's real password.
  if (ZM_EMAIL === DEFAULT_DEV_EMAIL) {
    const { data: list, error: listError } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    if (listError) {
      console.error(`Failed to list users: ${listError.message}`);
      process.exit(1);
    }
    const existing = list.users.find((u) => u.email === ZM_EMAIL);
    if (!existing) {
      console.error(`User ${ZM_EMAIL} exists but was not found via admin API.`);
      process.exit(1);
    }
    const updated = await admin.auth.admin.updateUserById(existing.id, {
      password: ZM_PASSWORD,
    });
    if (updated.error) {
      console.error(`Failed to sync password: ${updated.error.message}`);
      process.exit(1);
    }
    console.log(`✓ user exists — password synced to the seeded env`);
  } else {
    console.log(
      `✓ user ${ZM_EMAIL} exists — password left as-is (custom account); ` +
        `ensure ZM_PASSWORD matches it`
    );
  }
} else {
  console.log(`✓ created user ${ZM_EMAIL}`);
}

const mailUrl = env.get('MAILPIT_URL') ?? env.get('INBUCKET_URL');
console.log(
  'Done. `bun dev` will now boot server (:8787), web (:3100) and watcher.'
);
if (mailUrl) {
  console.log(
    `Sign-up confirmation emails land in the mail catcher: ${mailUrl}`
  );
}
