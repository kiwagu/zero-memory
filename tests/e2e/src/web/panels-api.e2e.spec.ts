/**
 * The data behind a panel of the chain. It is exactly what the resource's own
 * page shows, read under the viewer's session — so another user's private
 * memory is as absent here as it is on its page, and a malformed request finds
 * nothing rather than an error.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

const remember = async (token: string, content: string) => {
  const mcp = await McpTestClient.connect(token);
  try {
    const stored = await mcp.callTool('remember', {
      content,
      kind: 'fact',
      scope: 'personal',
    });
    expect(stored.isError ?? false).toBe(false);
    return firstJson<{ memory_id: string }>(stored).memory_id;
  } finally {
    await mcp.close();
  }
};

test.describe('Panel data over HTTP', () => {
  test('serves what the page shows, and nothing a viewer may not read', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const stamp = Date.now();
    const mine = await remember(
      await passwordGrantToken(seed.userA),
      `panels-api marker ${stamp}: the viewer's own memory`
    );
    const theirs = await remember(
      await passwordGrantToken(seed.userB),
      `panels-api marker ${stamp}: someone else's private memory`
    );

    await signInThroughForm(page, seed.userA);

    const own = await page.request.get(`/api/panels/memory/${mine}`);
    expect(own.status()).toBe(200);
    const payload = (await own.json()) as {
      kind: string;
      title: string;
      view: { detail: { content: string } };
    };
    expect(payload.kind).toBe('memory');
    expect(payload.view.detail.content).toContain(`panels-api marker ${stamp}`);
    expect(payload.title).toContain('panels-api marker');

    // Another user's private memory: indistinguishable from none at all.
    const foreign = await page.request.get(`/api/panels/memory/${theirs}`);
    expect(foreign.status()).toBe(404);

    // A malformed id or an unknown kind finds nothing.
    expect(
      (await page.request.get('/api/panels/memory/not-an-id')).status()
    ).toBe(404);
    expect(
      (await page.request.get(`/api/panels/widget/${mine}`)).status()
    ).toBe(404);
  });
});
