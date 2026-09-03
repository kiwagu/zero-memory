/**
 * A transport session is bound to the user that created it: presenting a
 * foreign mcp-session-id must be indistinguishable from a nonexistent one
 * (404, never 403), while the creating user can keep using it.
 */
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

const AUTH_SCHEME = 'Bearer';

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'zm-e2e-session-ownership', version: '0.1.0' },
  },
};

const listToolsBody = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
};

test.describe('MCP session ownership', () => {
  test('@smoke a foreign session id 404s; the creating user is unaffected', async ({
    request,
  }) => {
    const seed = await readSeedState();
    const tokenA = await passwordGrantToken(seed.userA);
    const tokenB = await passwordGrantToken(seed.userB);

    // userA initializes a session; the transport hands the id back on the
    // mcp-session-id response header.
    const init = await request.post(`${e2eEnv.serverUrl}/mcp`, {
      headers: {
        authorization: `${AUTH_SCHEME} ${tokenA}`,
        accept: 'application/json, text/event-stream',
      },
      data: initializeBody,
    });
    expect(init.ok()).toBe(true);
    const sessionId = init.headers()['mcp-session-id'];
    expect(sessionId).toBeTruthy();

    // Control: userA replays the same session id — must NOT be a 404, so the
    // test actually proves the guard discriminates by owner rather than the
    // route being broken for every replay.
    const sameUser = await request.post(`${e2eEnv.serverUrl}/mcp`, {
      headers: {
        authorization: `${AUTH_SCHEME} ${tokenA}`,
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
      },
      data: listToolsBody,
    });
    expect(sameUser.status()).not.toBe(404);

    // userB presents the same session id: refused as if it never existed.
    const foreignUser = await request.post(`${e2eEnv.serverUrl}/mcp`, {
      headers: {
        authorization: `${AUTH_SCHEME} ${tokenB}`,
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
      },
      data: listToolsBody,
    });
    expect(foreignUser.status()).toBe(404);
    const foreignBody = await foreignUser.json();
    expect(foreignBody.error?.message).toBe('Session not found');
  });
});
