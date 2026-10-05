import { Elysia } from 'elysia';
import { describe, expect, it } from 'vitest';

import type { IAuthGateway } from './auth-gateway.js';
import { InMemoryOAuthStore } from './in-memory-oauth-store.js';
import { mcpAuthPlugin } from './plugin.js';

const auth: IAuthGateway = {
  verifyAccessToken: async () => null,
  mintSession: async () => null,
  refreshSession: async () => ({ kind: 'ended' }),
  revokeSession: async () => undefined,
};

const register = (app: {
  handle: (request: Request) => Promise<Response> | Response;
}) =>
  app.handle(
    new Request('http://server.test/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/cb'] }),
    })
  );

describe('the rate-limit key behind a forwarding app', () => {
  it('takes the client address from the listening app, so callers do not share one bucket', async () => {
    delete process.env.ZM_TRUST_PROXY;
    // The plugin's own app never listens here, as in the server's wiring; the
    // address has to come from whoever does.
    let address = '203.0.113.10';
    const inner = new Elysia().use(
      mcpAuthPlugin({
        issuer: 'http://server.test',
        webUrl: 'http://web.test',
        store: new InMemoryOAuthStore(),
        auth,
        rateLimit: { maxRequests: 2, windowSeconds: 60 },
        requestIp: () => ({ requestIP: () => ({ address }) }),
      })
    );
    expect((await register(inner)).status).toBe(201);
    expect((await register(inner)).status).toBe(201);
    expect((await register(inner)).status).toBe(429);
    // Another caller is another bucket.
    address = '203.0.113.11';
    expect((await register(inner)).status).toBe(201);
  });
});
