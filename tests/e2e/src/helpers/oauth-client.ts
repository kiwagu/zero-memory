/**
 * An OAuth client as the specs play one: registered through dynamic client
 * registration, opening an authorization request in the browser, and
 * listening on a loopback port for the code — a real listener, because a
 * reconnect arrives through a chain of redirects that request interception
 * does not follow. Plus a client registered straight in the database, for
 * specs that record an agent session by hand and only need a client to name.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { createClient } from '@supabase/supabase-js';
import { expect, type APIRequestContext } from '@playwright/test';

import { e2eEnv } from './env.js';

/** The loopback return address a spec's listener answers on. */
export const loopbackRedirectUri = (port: number): string =>
  `http://127.0.0.1:${port}/callback`;

/** Registers a public client the way an agent does; returns its id. */
export const registerClient = async (
  request: APIRequestContext,
  clientName: string,
  redirectUri: string
): Promise<string> => {
  const response = await request.post(`${e2eEnv.serverUrl}/oauth/register`, {
    data: {
      client_name: clientName,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).client_id as string;
};

/** A fresh authorization request, as a client would open it. */
export const authorizeRequest = (clientId: string, redirectUri: string) => {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(8).toString('base64url');
  const url = new URL(`${e2eEnv.serverUrl}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
  }).toString();
  return { url: url.toString(), verifier, state };
};

/**
 * The OAuth routes are rate-limited per address in fixed windows, and the API
 * spec's burst test exhausts the token route on purpose; a spec that starts
 * within the same minute would meet a 429. Probe with a harmless invalid
 * request and wait out Retry-After once, so it starts in a fresh window.
 */
export const awaitRouteCooldown = async (
  request: APIRequestContext,
  path: string,
  method: 'get' | 'post' = 'post'
): Promise<void> => {
  const url = `${e2eEnv.serverUrl}${path}`;
  const probe =
    method === 'get'
      ? await request.get(url, { maxRedirects: 0 })
      : await request.post(url, { data: {} });
  if (probe.status() === 429) {
    const retryAfter = Number.parseInt(
      probe.headers()['retry-after'] ?? '60',
      10
    );
    await new Promise((resolve) =>
      setTimeout(resolve, (retryAfter + 1) * 1000)
    );
  }
};

/** The client's loopback listener: whatever reaches it is answered with 200. */
export const startLoopbackListener = (port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });

/**
 * A client row written with the service role, for a spec that records an
 * agent session by hand: every agent session names the client it was minted
 * for.
 */
export const insertTestClient = async (label: string): Promise<string> => {
  const admin = createClient(
    e2eEnv.supabaseUrl,
    e2eEnv.supabaseServiceRoleKey,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { data, error } = await admin
    .from('oauth_clients')
    .insert({
      client_name: `zm-e2e ${label} ${randomUUID().slice(0, 8)}`,
      redirect_uris: ['http://127.0.0.1/callback'],
    })
    .select('client_id')
    .single();
  if (error || !data) {
    throw new Error(`registering a test client failed: ${error?.message}`);
  }
  return data.client_id as string;
};
