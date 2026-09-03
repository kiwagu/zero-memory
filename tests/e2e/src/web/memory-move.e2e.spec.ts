/**
 * Manual re-scope from the memory detail page: the owner moves ONE memory
 * into a project scope through the always-available "Move to project" control
 * (unlike the feed's batch modal, it does not depend on pending fallbacks).
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('memory move from the detail page @smoke', () => {
  test('owner moves a personal memory into a project scope', async ({
    page,
  }) => {
    const seed = await readSeedState();

    // Seed the project scope FIRST, in its own session — a hint-pinned read
    // in the same session as the scope-less write would trigger the
    // late-attach repair and move the memory before the UI ever acts.
    const pinning = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    let projectScope: string;
    try {
      const briefed = firstJson<{ project_scope?: string }>(
        await pinning.callTool('build_context', {
          topic: 'potoroo cache',
          project_hint: '/home/someone/repos/potoroo-cache-e2e',
        })
      );
      projectScope = briefed.project_scope!;
      expect(projectScope).toMatch(/^proj\./);
    } finally {
      await pinning.close();
    }

    // The stray memory is written deliberately into the personal scope — the
    // shape a legacy mis-route left behind, and the input the move repairs.
    const unattached = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    let memoryId: string;
    try {
      const stray = firstJson<{ memory_id: string; scope?: string }>(
        await unattached.callTool('remember', {
          content:
            'web-e2e move marker: the potoroo cache invalidates by key prefix',
          scope: 'personal',
        })
      );
      expect(stray.scope).toMatch(/^user\./);
      memoryId = stray.memory_id;
    } finally {
      await unattached.close();
    }

    await signInThroughForm(page, seed.userB);
    await page.goto(`/memory/${memoryId}`);

    await page.getByTestId('memory-move').click();
    await page.getByTestId('memory-move-target').click();
    await page.getByRole('option', { name: /potoroo/i }).click();
    await page.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(page.getByTestId('memory-move-done')).toBeVisible();

    // The move is real: the memory is recallable from the project scope.
    const verify = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const recalled = await verify.callTool('recall', {
        query: 'how does the potoroo cache invalidate entries?',
        scopes: [projectScope],
        k: 5,
      });
      const hits = firstJson<{ memories: Array<{ id: string }> }>(recalled);
      expect(hits.memories.map((m) => m.id)).toContain(memoryId);
    } finally {
      await verify.close();
    }
  });
});
