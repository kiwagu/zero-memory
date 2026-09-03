/**
 * Rehearse the production deployment path against the isolated REVIEW stack.
 *
 * It addresses `zero-memory-review` (ports 5534x) rather than the test stack:
 * this rehearsal wants a clone of live left standing, and the test stack starts
 * every suite run by resetting its database — the two evict each other, which is
 * why the review stack exists.
 *
 * This command never snapshots or writes the live stack. Restoring requires an
 * explicit existing snapshot path, then replaces only zero-memory-review. The
 * app containers run as a separate Compose project on review-only ports.
 *
 * Usage:
 *   bun scripts/rehearse-production.ts restore <existing-snapshot>
 *   bun scripts/rehearse-production.ts up
 *   bun scripts/rehearse-production.ts verify
 *   bun scripts/rehearse-production.ts trust
 *   bun scripts/rehearse-production.ts status
 *   bun scripts/rehearse-production.ts down
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';

const root = resolve(import.meta.dir, '..');
const action = process.argv[2] ?? 'up';
const snapshotArg = process.argv[3];

const project = 'zero-memory-prod-review';
const reviewWorkdir = resolve(root, 'tests/e2e/review');
const composeFiles = [
  resolve(root, 'infra/prod/docker-compose.yml'),
  resolve(root, 'infra/prod/docker-compose.caddy.yml'),
];

const serverUrl = 'https://zm.localhost:18443';
const webUrl = 'https://memory.localhost:18443';
const docsUrl = 'https://docs.localhost:18443';
const supabasePublicUrl = 'https://supabase.localhost:18443';

const reviewEmail = 'prod-review@zm.e2e';
const reviewPassword = 'zero-memory-prod-review';

interface RunOptions {
  capture?: boolean;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
}

function run(
  command: string,
  args: string[],
  options: RunOptions = {}
): string {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: options.env ?? process.env,
  });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture
      ? (result.stderr || result.stdout || '').trim()
      : '';
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${result.status})` +
        (detail ? `: ${detail}` : '')
    );
  }
  return result.stdout ?? '';
}

function parseEnv(output: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) {
      env.set(match[1], match[2]);
    }
  }
  return env;
}

function reviewEnv(): {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
} {
  const output = run(
    'bunx',
    ['supabase', 'status', '-o', 'env', '--workdir', reviewWorkdir],
    { capture: true }
  );
  const env = parseEnv(output);
  const apiUrl = env.get('API_URL');
  const anonKey = env.get('ANON_KEY');
  const serviceRoleKey = env.get('SERVICE_ROLE_KEY');
  if (!apiUrl || !anonKey || !serviceRoleKey) {
    throw new Error(
      'The isolated zero-memory-review stack is not up or did not expose its ' +
        'keys — stand it up with: bun --cwd tests/e2e run review:stack'
    );
  }
  return { apiUrl, anonKey, serviceRoleKey };
}

async function provisionReviewUser(
  apiUrl: string,
  serviceRoleKey: string
): Promise<void> {
  const admin = createClient(apiUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const created = await admin.auth.admin.createUser({
    email: reviewEmail,
    password: reviewPassword,
    email_confirm: true,
  });
  if (!created.error) {
    process.stdout.write(`✓ created isolated review user ${reviewEmail}\n`);
    return;
  }
  if (created.error.code !== 'email_exists') {
    throw new Error(
      `Could not provision review user: ${created.error.message}`
    );
  }
  const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listed.error) {
    throw new Error(`Could not list review users: ${listed.error.message}`);
  }
  const existing = listed.data.users.find((user) => user.email === reviewEmail);
  if (!existing) {
    throw new Error(
      `${reviewEmail} exists but was not returned by Auth admin.`
    );
  }
  const updated = await admin.auth.admin.updateUserById(existing.id, {
    password: reviewPassword,
    email_confirm: true,
  });
  if (updated.error) {
    throw new Error(`Could not sync review user: ${updated.error.message}`);
  }
  process.stdout.write(`✓ synced isolated review user ${reviewEmail}\n`);
}

/**
 * The isolated stack is addressed through its PUBLISHED port rather than by
 * container name on a shared Docker network — that is what makes the rehearsal
 * exercise the default "database lives elsewhere" topology instead of the
 * co-located one.
 */
function externalSupabaseHost(apiUrl: string): string {
  const { port } = new URL(apiUrl);
  if (!port) {
    throw new Error(`The review Supabase URL has no published port: ${apiUrl}`);
  }
  return `host.docker.internal:${port}`;
}

function withReviewEnv<T>(
  keys: { apiUrl: string; anonKey: string; serviceRoleKey: string },
  fn: (envPath: string) => T
): T {
  const composeEnv = (value: string): string => {
    if (/[\r\n]/.test(value)) {
      throw new Error('A Compose environment value contains a newline.');
    }
    // Compose treats $NAME inside env-file values as interpolation. Supabase
    // opaque keys may contain a dollar sign, so double it before Compose sees
    // the temporary file; the container receives the original single `$`.
    return value.replaceAll('$', '$$');
  };
  const dir = mkdtempSync(resolve(tmpdir(), 'zm-prod-review-'));
  const envPath = resolve(dir, '.env');
  const supabaseHost = externalSupabaseHost(keys.apiUrl);
  const content = [
    // The stand builds its own images; an inherited prefix would silently
    // review someone else's build.
    'ZM_IMAGE_PREFIX=',
    'ZM_IMAGE_TAG=latest',
    `SUPABASE_URL=http://${supabaseHost}`,
    `SUPABASE_UPSTREAM=${supabaseHost}`,
    `SUPABASE_ANON_KEY=${composeEnv(keys.anonKey)}`,
    `SUPABASE_SERVICE_ROLE_KEY=${composeEnv(keys.serviceRoleKey)}`,
    'ZM_BIND_HOST=127.0.0.1',
    'ZM_SERVER_PORT=18787',
    `ZM_PUBLIC_URL=${serverUrl}`,
    'ZM_TRUST_PROXY=true',
    `ZM_EMAIL=${reviewEmail}`,
    `ZM_PASSWORD=${reviewPassword}`,
    'ANTHROPIC_API_KEY=review-extraction-disabled',
    'ZM_WEB_PORT=13100',
    `NEXT_PUBLIC_SUPABASE_URL=${supabasePublicUrl}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${composeEnv(keys.anonKey)}`,
    'ZM_DOCS_PORT=13200',
    // The documentation image bakes these in, so the stand states its OWN
    // addresses rather than the published instance's defaults.
    `ZM_HOSTED_MCP_URL=${serverUrl}/mcp`,
    `ZM_HOSTED_WEB_URL=${webUrl}`,
    'CADDYFILE_PATH=./caddy/Caddyfile.rehearsal',
    'ZM_SERVER_HOST=zm.localhost',
    'ZM_WEB_HOST=memory.localhost',
    'ZM_DOCS_HOST=docs.localhost',
    'SUPABASE_HOST=supabase.localhost',
    'CADDY_BIND_HOST=127.0.0.1',
    'CADDY_HTTP_PORT=18080',
    'CADDY_HTTPS_PORT=18443',
    '',
  ].join('\n');
  writeFileSync(envPath, content, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  try {
    return fn(envPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function composeArgs(envPath: string, tail: string[]): string[] {
  return [
    'compose',
    '--project-directory',
    resolve(root, 'infra/prod'),
    '--env-file',
    envPath,
    '--project-name',
    project,
    ...composeFiles.flatMap((file) => ['--file', file]),
    ...tail,
  ];
}

const composeVariableNames = [
  'ZM_IMAGE_PREFIX',
  'ZM_IMAGE_TAG',
  'SUPABASE_DOCKER_NETWORK',
  'SUPABASE_UPSTREAM',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ZM_BIND_HOST',
  'ZM_SERVER_PORT',
  'ZM_PUBLIC_URL',
  'ZM_TRUST_PROXY',
  'ZM_EMAIL',
  'ZM_PASSWORD',
  'ANTHROPIC_API_KEY',
  'ZM_WEB_PORT',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'ZM_DOCS_PORT',
  'ZM_DOCS_UPLOAD_TOKEN',
  'ZM_CLIENT_BUNDLE_URL',
  'ZM_CLIENT_BUNDLE_VERSION',
  'ZM_HOSTED_MCP_URL',
  'ZM_HOSTED_WEB_URL',
  'CADDYFILE_PATH',
  'ZM_SERVER_HOST',
  'ZM_WEB_HOST',
  'ZM_DOCS_HOST',
  'SUPABASE_HOST',
  'CADDY_BIND_HOST',
  'CADDY_HTTP_PORT',
  'CADDY_HTTPS_PORT',
] as const;

/**
 * Bun auto-loads the repository's root .env into process.env. Compose gives
 * process env precedence over --env-file, so inheriting it here could silently
 * point the review containers back at dev/stage. Remove every deployment input
 * and make the explicit temporary env file the sole source of truth.
 */
function isolatedComposeProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of composeVariableNames) {
    delete env[name];
  }
  return env;
}

function runCompose(envPath: string, tail: string[]): string {
  return run('docker', composeArgs(envPath, tail), {
    env: isolatedComposeProcessEnv(),
  });
}

interface ComposeConfig {
  services?: Record<
    string,
    {
      environment?: Record<string, string>;
      build?: { args?: Record<string, string> };
      ports?: Array<{ host_ip?: string; published?: string }>;
    }
  >;
  networks?: Record<string, { name?: string }>;
}

function assertReviewComposeIsolation(
  envPath: string,
  expectedSupabaseUrl: string
): void {
  const raw = run(
    'docker',
    composeArgs(envPath, ['config', '--format', 'json']),
    { capture: true, env: isolatedComposeProcessEnv() }
  );
  const config = JSON.parse(raw) as ComposeConfig;
  const server = config.services?.['zm-server'];
  const web = config.services?.['zm-web'];
  const checks: Array<[unknown, unknown, string]> = [
    [
      server?.environment?.SUPABASE_URL,
      expectedSupabaseUrl,
      'server Supabase URL',
    ],
    [server?.environment?.ZM_PUBLIC_URL, serverUrl, 'OAuth issuer'],
    [server?.environment?.ZM_TRUST_PROXY, 'true', 'trusted-proxy mode'],
    [
      web?.environment?.SUPABASE_URL,
      expectedSupabaseUrl,
      'web server-side Supabase URL',
    ],
    // Browser-facing values are runtime environment now, not build args — the
    // image is deployment-agnostic, so this is the only place they are pinned.
    [
      web?.environment?.NEXT_PUBLIC_SUPABASE_URL,
      supabasePublicUrl,
      'browser Supabase URL',
    ],
    // The stand must not join ANY foreign Docker network: the attach overlay is
    // the one way a review container could end up next to the dev/stage stack.
    [
      config.networks?.supabase,
      undefined,
      'absence of an attached database network',
    ],
  ];
  for (const [actual, expected, label] of checks) {
    if (actual !== expected) {
      throw new Error(
        `Review Compose isolation failed for ${label}: expected ${String(expected)}, got ${String(actual)}.`
      );
    }
  }
  for (const [serviceName, service] of [
    ['zm-server', server],
    ['zm-web', web],
    ['zm-docs', config.services?.['zm-docs']],
    ['caddy', config.services?.caddy],
  ] as const) {
    for (const port of service?.ports ?? []) {
      if (port.host_ip !== '127.0.0.1') {
        throw new Error(
          `Review Compose isolation failed for ${serviceName} port ${String(port.published)}: expected loopback bind, got ${String(port.host_ip)}.`
        );
      }
    }
  }
  process.stdout.write(
    '✓ Compose isolation points only at zero-memory-review\n'
  );
}

function curl(args: string[], allowHttpError = false): string {
  return run('curl', ['--silent', '--show-error', '--insecure', ...args], {
    capture: true,
    allowFailure: allowHttpError,
  });
}

function readJson(url: string): Record<string, unknown> {
  const body = curl(['--fail', url]);
  return JSON.parse(body) as Record<string, unknown>;
}

function verify(): void {
  const health = readJson(`${serverUrl}/healthz`);
  if (health.ok !== true) {
    throw new Error('/healthz did not report ok=true.');
  }

  const ready = readJson(`${serverUrl}/readyz`);
  const checks = ready.checks as Record<string, unknown> | undefined;
  if (ready.ok !== true || checks?.supabase !== true) {
    throw new Error('/readyz did not report a reachable Supabase.');
  }

  const discovery = readJson(
    `${serverUrl}/.well-known/oauth-authorization-server`
  );
  if (discovery.issuer !== serverUrl) {
    throw new Error(
      `OAuth issuer mismatch: expected ${serverUrl}, got ${String(discovery.issuer)}`
    );
  }

  curl(['--fail', `${webUrl}/login`]);

  // The dashboard's own readiness: it answers only when it can reach the MCP
  // server over the container network. A deployment once served a perfectly
  // healthy login page while that leg was broken, and nothing here noticed.
  const webHealth = readJson(`${webUrl}/healthz`);
  if (webHealth.ok !== true) {
    throw new Error(
      `The dashboard cannot reach the MCP server: ${JSON.stringify(webHealth.server)}`
    );
  }
  curl(['--fail', `${supabasePublicUrl}/auth/v1/health`]);

  // The documentation site: a rendered page, and one image, since `public/` is
  // not part of a standalone bundle and has to be copied into the image by
  // hand — a defect that leaves the prose intact and every asset 404. The
  // upload path is asserted CLOSED at the edge: it is the site's only write
  // path, and a rule that is never exercised is a rule that quietly stops
  // holding.
  curl(['--fail', `${docsUrl}/docs`]);
  curl([
    '--fail',
    '--output',
    '/dev/null',
    `${docsUrl}/img/dashboard-overview.png`,
  ]);
  const upload = curl(
    ['--include', '--request', 'POST', `${docsUrl}/upload`],
    true
  );
  if (!/HTTP\/(?:1\.1|2) 404/.test(upload)) {
    throw new Error('The documentation edge did not block POST /upload.');
  }

  const challenge = curl(
    ['--include', '--request', 'POST', `${serverUrl}/mcp`],
    true
  );
  if (!/HTTP\/(?:1\.1|2) 401/.test(challenge)) {
    throw new Error('Unauthenticated POST /mcp did not return 401.');
  }
  if (!challenge.includes(serverUrl)) {
    throw new Error('The MCP 401 challenge did not carry the external issuer.');
  }

  process.stdout.write(
    [
      '✓ production-path review stand verified',
      `  MCP:      ${serverUrl}/mcp`,
      `  Web:      ${webUrl}/login`,
      `  Docs:     ${docsUrl}/docs`,
      `  Supabase: ${supabasePublicUrl}`,
      '  TLS uses Caddy internal CA; browser/curl will require local trust.',
      '',
    ].join('\n')
  );
}

function restoreSnapshot(): void {
  if (!snapshotArg) {
    throw new Error(
      'restore requires an explicit existing snapshot path; live snapshotting is intentionally unavailable here.'
    );
  }
  const snapshot = resolve(root, snapshotArg);
  // Readability proves the caller supplied a file before the destructive e2e
  // replacement begins. Never infer "latest": an explicit artifact is part of
  // the rehearsal record.
  const fd = openSync(snapshot, 'r');
  try {
    readSync(fd, Buffer.alloc(1), 0, 1, 0);
  } finally {
    closeSync(fd);
  }
  process.stdout.write(
    `→ restoring ${basename(snapshot)} into zero-memory-review only…\n`
  );
  run('bash', [
    resolve(root, 'scripts/zm-cluster.sh'),
    'clone-to-review',
    snapshot,
  ]);
}

/**
 * Make the stand's own CA usable in a desktop browser.
 *
 * The obvious route — `certutil` into the system NSS database — does NOT work
 * on a browser that verifies through the Chrome Root Store, and fails in a way
 * that reads as "nothing happened": the certificate manager shows the imported
 * root under *intermediate* certificates, never under trusted ones, so the
 * site keeps returning ERR_CERT_AUTHORITY_INVALID. Measured here: with the CA
 * removed from every NSS database on the machine, the browser trusts the stand
 * anyway once the policy below is in place — the policy is the whole fix, and
 * the NSS import was never doing anything.
 *
 * So this writes a policy carrying the CA as a trust ANCHOR and prints the one
 * root-owned command to install it, rather than touching the user's trust
 * databases. Browsers with their own store (Firefox) still need the exported
 * certificate imported by hand — its path is printed too.
 */
function trustReviewCa(): void {
  const caPath = resolve(tmpdir(), 'zero-memory-review-ca.crt');
  const pem = run(
    'docker',
    [
      'exec',
      `${project}-caddy-1`,
      'cat',
      '/data/caddy/pki/authorities/local/root.crt',
    ],
    { capture: true }
  );
  writeFileSync(caPath, pem);
  process.stdout.write(`✓ review CA written to ${caPath}\n`);

  const policyPath = resolve(tmpdir(), 'zero-memory-local-ca-trust.json');
  // A PEM body already IS the base64 DER the policy wants — no re-encoding,
  // and no round trip through a binary pipe that a utf8 capture would corrupt.
  const base64Der = pem
    .replace(/-----(?:BEGIN|END) CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  writeFileSync(
    policyPath,
    `${JSON.stringify(
      {
        // Lets the browser consider user-added platform certificates at all.
        CAPlatformIntegrationEnabled: true,
        CACertificates: [base64Der],
      },
      null,
      2
    )}\n`
  );

  process.stdout.write(
    `\n✓ browser policy written to ${policyPath}\n\n` +
      'One-time step, needs root (snap-packaged Chromium shown; a distro\n' +
      'package reads /etc/chromium/policies/managed instead):\n\n' +
      '  sudo mkdir -p /var/snap/chromium/current/policies/managed\n' +
      `  sudo cp ${policyPath} \\\n` +
      '    /var/snap/chromium/current/policies/managed/local-ca-trust.json\n\n' +
      'Then quit the browser completely (not just the window) and reopen it —\n' +
      'reloading policies alone is not enough. chrome://policy must show both\n' +
      'policies as OK.\n\n' +
      `For a browser with its own store (Firefox), import ${caPath} there by\n` +
      'hand instead.\n'
  );
}

async function main(): Promise<void> {
  if (action === 'trust') {
    trustReviewCa();
    return;
  }
  if (action === 'restore') {
    restoreSnapshot();
    return;
  }
  if (action === 'verify') {
    verify();
    return;
  }
  if (action === 'status') {
    runCompose(resolve(root, 'infra/prod/.env.example'), ['ps']);
    return;
  }
  if (action === 'down') {
    // Values are irrelevant to `down`; the example env keeps Compose
    // interpolation deterministic without persisting review credentials.
    const exampleEnv = resolve(root, 'infra/prod/.env.example');
    runCompose(exampleEnv, ['down', '--remove-orphans']);
    return;
  }
  if (action !== 'up') {
    throw new Error(
      `Unknown action "${action}". Use restore, up, verify, trust, status or down.`
    );
  }

  const env = reviewEnv();
  await provisionReviewUser(env.apiUrl, env.serviceRoleKey);
  withReviewEnv(env, (envPath) => {
    assertReviewComposeIsolation(
      envPath,
      `http://${externalSupabaseHost(env.apiUrl)}`
    );
    runCompose(envPath, [
      'up',
      '--detach',
      '--build',
      '--wait',
      '--wait-timeout',
      '300',
    ]);
  });
  verify();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `production rehearsal failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
