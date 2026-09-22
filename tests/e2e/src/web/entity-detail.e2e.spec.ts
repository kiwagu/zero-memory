/**
 * An entity has a page of its own. A memory names its entities as chips, and a
 * chip leads to that entity by id — its connections and the memories that
 * mention it — rather than to a name search that may match several.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('Entity page in the dashboard', () => {
  test('a memory links to its entity, and the entity page shows what mentions it', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const name = `e2e-entity-detail-${Date.now()}`;
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let memoryId: string;
    try {
      const stored = await mcp.callTool('remember', {
        content: `entity-detail marker: ${name} is the queue the ingest worker drains`,
        kind: 'fact',
        project_hint: '/tmp/zm-e2e-entity-detail',
        entities: [{ name, type: 'concept' }],
      });
      expect(stored.isError ?? false).toBe(false);
      memoryId = firstJson<{ memory_id: string }>(stored).memory_id;
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto(`/memory/${memoryId}`);
    await page.getByRole('link', { name }).click();

    await expect(page).toHaveURL(/\/entities\/ent_[0-9a-z]{16}\.[0-9a-z]{10}$/);
    await expect(page.getByTestId('entity-name')).toContainText(name);
    await expect(page.getByTestId('entity-detail')).toContainText(
      'entity-detail marker'
    );
  });
});
