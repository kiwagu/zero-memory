/**
 * M3 acceptance smoke test: two users share memory through the streamable
 * HTTP MCP transport protected by the embedded OAuth 2.1 server.
 *
 * Flow:
 *   1. provision alice + bob (service role, idempotent),
 *   2. assert the unauthenticated 401 challenge on /mcp,
 *   3. alice: full OAuth flow (DCR -> authorize form -> code -> token),
 *   4. alice: create_scope + add bob as writer (user-JWT RPCs),
 *   5. alice via MCP: remember a fact in the project scope, then share it,
 *   6. bob: own OAuth flow (incl. refresh grant), recall + build_context see
 *      alice's shared memory; bob cannot share alice's memory.
 *
 * Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 * Optional: ZM_PUBLIC_URL (default http://localhost:8787) — the server must
 * already be running there.
 *
 * Usage: bun scripts/smoke-team.ts
 */
import { createHash, randomBytes } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createClient } from '@supabase/supabase-js';

const requiredEnv = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];
const missing = requiredEnv.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing env: ${missing.join(', ')}`);
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE_URL = (process.env.ZM_PUBLIC_URL ?? 'http://localhost:8787').replace(
  /\/$/,
  ''
);

const ALICE = {
  email: 'alice@zero-memory.local',
  password: 'smoke-alice-password-m3',
};
const BOB = {
  email: 'bob@zero-memory.local',
  password: 'smoke-bob-password-m3',
};

const fail = (message: string): never => {
  console.error(`\nSMOKE-TEAM FAILED: ${message}`);
  process.exit(1);
};

const step = (message: string): void => {
  console.log(`\n=== ${message} ===`);
};

// ── 1. provision users (idempotent) ─────────────────────────────────────────

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const provisionUser = async (user: {
  email: string;
  password: string;
}): Promise<void> => {
  const { error } = await admin.auth.admin.createUser({
    email: user.email,
    password: user.password,
    email_confirm: true,
  });
  if (error && error.code !== 'email_exists') {
    fail(`could not provision ${user.email}: ${error.message}`);
  }
  console.log(`user ready: ${user.email}`);
};

step('provision users');
await provisionUser(ALICE);
await provisionUser(BOB);

// ── 2. unauthenticated challenge ────────────────────────────────────────────

step('401 challenge on /mcp');
const challenge = await fetch(`${BASE_URL}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
});
if (challenge.status !== 401) {
  fail(`expected 401 for unauthenticated /mcp, got ${challenge.status}`);
}
const wwwAuthenticate = challenge.headers.get('www-authenticate') ?? '';
if (!wwwAuthenticate.includes('resource_metadata=')) {
  fail(`WWW-Authenticate lacks resource_metadata: "${wwwAuthenticate}"`);
}
console.log(`WWW-Authenticate: ${wwwAuthenticate}`);

const asMetadata = await fetch(
  `${BASE_URL}/.well-known/oauth-authorization-server`
).then((response) => response.json() as Promise<Record<string, unknown>>);
if (
  asMetadata.issuer !== BASE_URL ||
  asMetadata.token_endpoint !== `${BASE_URL}/oauth/token`
) {
  fail(`unexpected AS metadata: ${JSON.stringify(asMetadata)}`);
}
console.log('AS metadata OK');

// ── 3. programmatic OAuth 2.1 flow ──────────────────────────────────────────

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

const oauthFlow = async (user: {
  email: string;
  password: string;
}): Promise<Tokens> => {
  // RFC 7591 dynamic client registration.
  const registration = await fetch(`${BASE_URL}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: `smoke-team (${user.email})`,
      redirect_uris: ['http://127.0.0.1:41241/callback'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (registration.status !== 201) {
    fail(`DCR failed with ${registration.status}`);
  }
  const { client_id: clientId } = (await registration.json()) as {
    client_id: string;
  };

  // PKCE material.
  const verifier = randomBytes(48).toString('base64url');
  const challengeS256 = createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');
  const state = randomBytes(12).toString('base64url');

  const authorizeParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'http://127.0.0.1:41241/callback',
    response_type: 'code',
    code_challenge: challengeS256,
    code_challenge_method: 'S256',
    state,
    resource: `${BASE_URL}/mcp`,
  });

  // GET /oauth/authorize serves the self-contained login form.
  const loginPage = await fetch(
    `${BASE_URL}/oauth/authorize?${authorizeParams}`
  );
  const loginHtml = await loginPage.text();
  if (loginPage.status !== 200 || !loginHtml.includes('<form')) {
    fail(`authorize page did not render a form (${loginPage.status})`);
  }

  // POST credentials + the OAuth params (as the hidden fields would).
  const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...Object.fromEntries(authorizeParams),
      email: user.email,
      password: user.password,
    }),
    redirect: 'manual',
  });
  if (submit.status !== 302) {
    fail(`authorize submit expected 302, got ${submit.status}`);
  }
  const location = new URL(submit.headers.get('location') ?? '');
  if (location.searchParams.get('state') !== state) {
    fail('state mismatch in the authorization redirect');
  }
  const code = location.searchParams.get('code') ?? fail('no code returned');

  // Exchange the code (PKCE) for the Supabase session pair.
  const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:41241/callback',
    }),
  });
  if (tokenResponse.status !== 200) {
    fail(`token exchange failed with ${tokenResponse.status}`);
  }
  const tokens = (await tokenResponse.json()) as Tokens;
  if (tokens.token_type !== 'bearer' || !tokens.access_token) {
    fail(`unexpected token response: ${JSON.stringify(tokens)}`);
  }

  // Replays of the one-time code must fail.
  const replay = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:41241/callback',
    }),
  });
  if (replay.status !== 400) {
    fail(`code replay expected 400, got ${replay.status}`);
  }

  console.log(`OAuth flow OK for ${user.email} (scope: ${tokens.scope})`);
  return tokens;
};

step('alice: OAuth flow');
const aliceTokens = await oauthFlow(ALICE);

// ── 4. alice: create scope + grant bob (user-JWT RPCs under RLS) ────────────

const userClient = (accessToken: string) =>
  createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

const userIdOf = async (accessToken: string): Promise<string> => {
  const { data, error } =
    await userClient(accessToken).auth.getUser(accessToken);
  if (error || !data.user) {
    return fail(`could not resolve user for token: ${error?.message}`);
  }
  return data.user.id;
};

const scope = `project.smoketeam_${Date.now()}`;

step(`alice: create_scope('${scope}') + add bob as writer`);
const alice = userClient(aliceTokens.access_token);

const created = await alice.rpc('create_scope', { p_scope: scope });
if (created.error) {
  fail(`create_scope failed: ${created.error.message}`);
}

const bobId = await userIdOf((await oauthFlow(BOB)).access_token);
// (bob's first token pair above only resolved his id; his MCP session below
// exercises the refresh grant too.)
const granted = await alice.rpc('add_scope_member', {
  p_scope: scope,
  p_user: bobId,
  p_role: 'writer',
});
if (granted.error) {
  fail(`add_scope_member failed: ${granted.error.message}`);
}
console.log(`scope ready; bob (${bobId}) is a writer`);

// ── 5. MCP over streamable HTTP ─────────────────────────────────────────────

const mcpConnect = async (accessToken: string): Promise<Client> => {
  const client = new Client({ name: 'smoke-team', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE_URL}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    }
  );
  await client.connect(transport);
  return client;
};

const contentText = (result: unknown): string =>
  (
    (result as { content: Array<{ type: string; text?: string }> }).content ??
    []
  )
    .map((item) => item.text ?? '')
    .join('\n');

const marker = `smoketeam-${Date.now()}`;

step('alice: remember + share over MCP');
const aliceMcp = await mcpConnect(aliceTokens.access_token);

const remembered = await aliceMcp.callTool({
  name: 'remember',
  arguments: {
    content: `Team fact ${marker}: the smoke team deploys zero-memory on fridays only.`,
    kind: 'convention',
    scope,
  },
});
if (remembered.isError) {
  fail(`alice remember errored: ${contentText(remembered)}`);
}
const memoryId = (JSON.parse(contentText(remembered)) as { memory_id: string })
  .memory_id;
console.log(`alice remembered ${memoryId}`);

const shared = await aliceMcp.callTool({
  name: 'share',
  arguments: { memory_id: memoryId, scope },
});
if (shared.isError) {
  fail(`alice share errored: ${contentText(shared)}`);
}
const shareBody = JSON.parse(contentText(shared)) as {
  memory_id: string;
  scope: string;
  shared: boolean;
};
if (!shareBody.shared || shareBody.scope !== scope) {
  fail(`unexpected share output: ${contentText(shared)}`);
}
console.log(`alice shared ${memoryId} into ${scope}`);

step('bob: OAuth flow (with refresh grant) + recall');
const bobTokens = await oauthFlow(BOB);

// Refresh grant round-trips a fresh Supabase pair.
const refreshed = await fetch(`${BASE_URL}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: bobTokens.refresh_token,
  }),
});
if (refreshed.status !== 200) {
  fail(`refresh grant failed with ${refreshed.status}`);
}
const bobFresh = (await refreshed.json()) as Tokens;
if (!bobFresh.access_token || !bobFresh.refresh_token) {
  fail('refresh grant returned no session pair');
}
console.log('refresh grant OK for bob');

const bobMcp = await mcpConnect(bobFresh.access_token);

const recalled = await bobMcp.callTool({
  name: 'recall',
  arguments: { query: `smoke team deploy convention ${marker}`, k: 8 },
});
if (recalled.isError) {
  fail(`bob recall errored: ${contentText(recalled)}`);
}
if (!contentText(recalled).includes(memoryId)) {
  fail("bob's recall does not surface alice's shared memory");
}
console.log("bob's recall sees alice's shared memory");

const briefing = await bobMcp.callTool({
  name: 'build_context',
  arguments: { topic: `smoke team deploy convention ${marker}` },
});
if (briefing.isError) {
  fail(`bob build_context errored: ${contentText(briefing)}`);
}
if (!contentText(briefing).includes(memoryId)) {
  fail("bob's build_context briefing misses alice's shared memory");
}
console.log("bob's build_context sees alice's shared memory");

// Owner-only sharing: bob may not re-share alice's memory.
const bobShare = await bobMcp.callTool({
  name: 'share',
  arguments: { memory_id: memoryId, scope },
});
if (!bobShare.isError) {
  fail("bob was able to share alice's memory (owner-only rule broken)");
}
console.log("owner-only rule holds: bob cannot share alice's memory");

await aliceMcp.close();
await bobMcp.close();

console.log(
  '\nSMOKE-TEAM OK: OAuth 2.1 (DCR, PKCE, one-time code, refresh) + ' +
    'streamable HTTP MCP + scope sharing verified across two users.'
);
