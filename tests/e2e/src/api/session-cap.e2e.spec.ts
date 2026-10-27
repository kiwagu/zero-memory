/**
 * The server caps how many MCP sessions one account holds and evicts the
 * least recently used one past the cap. The watcher's hooks open a session per
 * run, so a hook client that leaves its session behind pushes out the
 * long-lived session of the person's editor, whose next call is answered
 * "Session not found". The watcher's transport ends its session when it
 * closes, and the server frees that session's place under the cap.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@playwright/test';
import {
  createAuthedTransport,
  OAuthStateStore,
} from '@workspace/mcp-oauth-client';

import { e2eEnv } from '../helpers/env.js';
import { McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

/** More one-shot clients than the server's default per-user cap (20). */
const ONE_SHOT_CLIENTS = 25;

const mcpUrl = `${e2eEnv.serverUrl}/mcp`;

/** Opens a session and closes it the way the SDK alone does: this side only. */
const runClientThatOnlyClosesItsSide = async (token: string): Promise<void> => {
  const client = new Client({ name: 'zm-e2e-one-shot', version: '0.1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
  );
  await client.close();
};

/** Opens a session through the watcher's transport and closes it. */
const runWatcherClient = async (store: OAuthStateStore): Promise<void> => {
  const client = new Client({ name: 'zm-e2e-one-shot', version: '0.1.0' });
  await client.connect(createAuthedTransport(mcpUrl, store));
  await client.close();
};

test.describe('MCP session cap', () => {
  test("one-shot watcher clients leave the editor's live session in place", async () => {
    // An account of its own: no other spec's sessions count against its cap.
    const user = await provisionE2EUser('session-cap@zm.e2e');
    const token = await passwordGrantToken(user);

    // Control: clients that leave their sessions behind push the live session
    // out, so the cap is in force at this count.
    const evicted = await McpTestClient.connect(token, 'zm-e2e-editor');
    for (let run = 0; run < ONE_SHOT_CLIENTS; run += 1) {
      await runClientThatOnlyClosesItsSide(token);
    }
    await expect(evicted.listToolNames()).rejects.toThrow(/Session not found/);

    // The watcher's transport reads its token from a store on disk, kept only
    // for the length of the test.
    const storeDir = mkdtempSync(join(tmpdir(), 'zm-e2e-oauth-'));
    try {
      const store = new OAuthStateStore(join(storeDir, 'oauth.json'));
      store.update(mcpUrl, {
        tokens: { access_token: token, token_type: 'Bearer' },
      });
      const editor = await McpTestClient.connect(token, 'zm-e2e-editor');
      for (let run = 0; run < ONE_SHOT_CLIENTS; run += 1) {
        await runWatcherClient(store);
      }
      expect(await editor.listToolNames()).toContain('recall');
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});
