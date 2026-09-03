/**
 * Declared supersede on write, end-to-end: a `supersedes` link on remember
 * retires the named old memory atomically (reversibly — restore revives it),
 * never touches a foreign memory, and closes an open loop the same way.
 */
import { expect, test } from '@playwright/test';

import { readSeedState } from '../helpers/runtime-state.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken } from '../helpers/users.js';

interface BriefingPack {
  open_loops: Array<{ id: string }>;
}

test.describe('Declared supersede over MCP', () => {
  test('remember with a supersedes link retires the old version (reversibly)', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const oldWrite = await mcp.callTool('remember', {
        content:
          'e2e declared-supersede marker: the ingest retry budget is 3 attempts',
        kind: 'decision',
        scope: 'personal',
      });
      expect(oldWrite.isError ?? false).toBe(false);
      const oldId = firstJson<{ memory_id: string }>(oldWrite).memory_id;

      const newWrite = await mcp.callTool('remember', {
        content:
          'e2e declared-supersede marker: the ingest retry budget moved to 5 ' +
          'attempts with exponential backoff',
        kind: 'decision',
        links: [{ dst: oldId, type: 'supersedes' }],
        scope: 'personal',
      });
      expect(newWrite.isError ?? false).toBe(false);
      const newId = firstJson<{ memory_id: string }>(newWrite).memory_id;
      expect(newId).not.toBe(oldId);

      // The old version is out of recall; the successor is in.
      const recalled = contentText(
        await mcp.callTool('recall', {
          query: 'what is the ingest retry budget?',
          k: 10,
        })
      );
      expect(recalled).toContain(newId);
      expect(recalled).not.toContain(oldId);

      // Reversible, ADD-only: restore revives the retired version — proof it
      // was invalidated (restore errs on a live memory), never deleted.
      const restored = await mcp.callTool('restore_memory', {
        memory_id: oldId,
      });
      expect(restored.isError ?? false).toBe(false);
      expect(firstJson<{ restored: boolean }>(restored).restored).toBe(true);

      // Leave the store clean: retire the old version again.
      const cleanup = await mcp.callTool('forget', { memory_id: oldId });
      expect(cleanup.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }
  });

  test('a declared supersede never touches a foreign memory', async () => {
    const seed = await readSeedState();
    const foreignOwner = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const actor = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const foreignWrite = await foreignOwner.callTool('remember', {
        content:
          'e2e declared-supersede marker: foreign convention that must survive',
        kind: 'convention',
        scope: 'personal',
      });
      expect(foreignWrite.isError ?? false).toBe(false);
      const foreignId = firstJson<{ memory_id: string }>(
        foreignWrite
      ).memory_id;

      // The actor names another user's PRIVATE memory as superseded. RLS
      // makes it invisible, so the link itself is rejected and the whole write fails cleanly —
      // the strictest safe outcome (a visible-but-foreign target is instead
      // skipped by the ownership check; covered at the unit level). Either
      // way the essential property holds: the foreign memory is never touched.
      const write = await actor.callTool('remember', {
        content:
          'e2e declared-supersede marker: actor statement naming a foreign id',
        kind: 'fact',
        links: [{ dst: foreignId, type: 'supersedes' }],
        scope: 'personal',
      });
      expect(write.isError ?? false).toBe(true);

      const stillThere = contentText(
        await foreignOwner.callTool('recall', {
          query: 'foreign convention that must survive',
          k: 10,
        })
      );
      expect(stillThere).toContain(foreignId);
    } finally {
      await actor.close();
      await foreignOwner.close();
    }
  });

  test('remembering the outcome with a supersedes link closes the open loop', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const task = await mcp.callTool('remember', {
        content:
          'e2e declared-supersede marker: rebuild the watcher binary on the ' +
          'stage machine — see /shares/zm/build.log',
        kind: 'task',
        scope: 'personal',
      });
      expect(task.isError ?? false).toBe(false);
      const taskId = firstJson<{ memory_id: string }>(task).memory_id;

      const done = await mcp.callTool('remember', {
        content:
          'e2e declared-supersede marker: watcher binary rebuilt and deployed ' +
          'on the stage machine, digest updated',
        kind: 'fact',
        links: [{ dst: taskId, type: 'supersedes' }],
        scope: 'personal',
      });
      expect(done.isError ?? false).toBe(false);

      // The loop is gone from briefings — no close_loop call needed.
      const pack = firstJson<BriefingPack>(
        await mcp.callTool('build_context', { topic: 'unrelated topic probe' })
      );
      expect(pack.open_loops.map((loop) => loop.id)).not.toContain(taskId);
    } finally {
      await mcp.close();
    }
  });
});
