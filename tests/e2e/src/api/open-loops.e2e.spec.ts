/**
 * Open loops end-to-end: a task handed over from one session ("machine A")
 * surfaces in another session's briefing ("machine B") above the ranked pack,
 * disappears from briefings once closed with close_loop, and stays in
 * history (ADD-only). The content guard applies to loop kinds like any write.
 */
import { expect, test } from '@playwright/test';

import { backdateMemory } from '../helpers/decay.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken } from '../helpers/users.js';

interface BriefingPack {
  memories: Array<{ id: string }>;
  linked_memories: Array<{ id: string }>;
  open_loops: Array<{ id: string; kind: string; content: string }>;
  open_loops_total: number;
}

test.describe('Open loops over MCP', () => {
  test('a task from machine A surfaces in machine B briefings until closed, then stays in history', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    // Two independent MCP sessions of the same owner: the sender (machine A)
    // and the receiver (machine B) of the inter-machine buffer.
    const machineA = await McpTestClient.connect(token);
    const machineB = await McpTestClient.connect(token);
    try {
      const remembered = await machineA.callTool('remember', {
        content:
          'e2e open-loop marker: check the watcher warnings on the stage ' +
          'machine — log pointer /shares/zm/watcher-stage.log, look for ' +
          'repeated oauth refresh failures',
        kind: 'task',
        scope: 'personal',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);

      // The receiving machine briefs on an UNRELATED topic: the loop must
      // surface anyway (open loops are lifecycle, not relevance).
      const briefing = await machineB.callTool('build_context', {
        topic: 'dashboard feed pagination',
      });
      expect(briefing.isError ?? false).toBe(false);
      const pack = firstJson<BriefingPack>(briefing);
      const loop = pack.open_loops.find((entry) => entry.id === memory_id);
      expect(
        loop,
        'active task must be in the open_loops section'
      ).toBeTruthy();
      expect(loop!.kind).toBe('task');
      expect(pack.open_loops_total).toBeGreaterThanOrEqual(1);
      // ...and never duplicated into the ranked legs.
      expect(
        [...pack.memories, ...pack.linked_memories].map((m) => m.id)
      ).not.toContain(memory_id);

      // The receiving machine completes the work and closes the loop.
      const closed = await machineB.callTool('close_loop', { memory_id });
      expect(closed.isError ?? false).toBe(false);
      expect(firstJson<{ closed: boolean }>(closed).closed).toBe(true);

      const after = firstJson<BriefingPack>(
        await machineB.callTool('build_context', {
          topic: 'dashboard feed pagination',
        })
      );
      expect(after.open_loops.map((entry) => entry.id)).not.toContain(
        memory_id
      );

      // Double-closing is a clean error, not a silent no-op.
      const again = await machineB.callTool('close_loop', { memory_id });
      expect(again.isError ?? false).toBe(true);

      // ADD-only history: the closed loop still exists (restore revives it),
      // it was never deleted. Re-close to leave the stack clean.
      const restored = await machineA.callTool('restore_memory', { memory_id });
      expect(restored.isError ?? false).toBe(false);
      expect(firstJson<{ restored: boolean }>(restored).restored).toBe(true);
      const reclose = await machineA.callTool('close_loop', { memory_id });
      expect(reclose.isError ?? false).toBe(false);
    } finally {
      await machineA.close();
      await machineB.close();
    }
  });

  test('an open-question surfaces and closes the same way', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const remembered = await mcp.callTool('remember', {
        content:
          'e2e open-loop marker: should the ingest retry budget stay at 3 ' +
          'attempts once the queue moves to pgmq?',
        kind: 'open-question',
        scope: 'personal',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);

      const pack = firstJson<BriefingPack>(
        await mcp.callTool('build_context', { topic: 'anything else entirely' })
      );
      const loop = pack.open_loops.find((entry) => entry.id === memory_id);
      expect(loop?.kind).toBe('open-question');

      const closed = await mcp.callTool('close_loop', { memory_id });
      expect(closed.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }
  });

  test('close_loop refuses a non-loop kind', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const remembered = await mcp.callTool('remember', {
        content:
          'e2e open-loop marker: bun loads .env only from the cwd of the ' +
          'process, not from the workspace root',
        kind: 'gotcha',
        scope: 'personal',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);

      const refused = await mcp.callTool('close_loop', { memory_id });
      expect(refused.isError ?? false).toBe(true);
      expect(contentText(refused)).toContain('not an open loop');

      // Still recallable: the refusal must not have touched the memory.
      const recalled = await mcp.callTool('recall', {
        query: 'where does bun load .env from?',
        k: 10,
      });
      expect(contentText(recalled)).toContain(memory_id);
    } finally {
      await mcp.close();
    }
  });

  test('a loop past the soft TTL leaves the briefing but stays recallable', async () => {
    const seed = await readSeedState();
    // User B: this test's mid-suite write must not shift user A's recall
    // pool while the parity specs (memory-search, recall-translate) compare
    // two sequential A-recalls for id equality.
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const remembered = await mcp.callTool('remember', {
        content:
          'e2e open-loop marker: soft-ttl probe — revisit the quokka export ' +
          'once the batch importer stabilizes',
        kind: 'task',
        scope: 'personal',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);

      // Age the unclosed loop past the default 14-day briefing window.
      await backdateMemory(memory_id, 20);

      // Gone from the briefing section (and from its "N more" count basis)…
      const pack = firstJson<BriefingPack>(
        await mcp.callTool('build_context', { topic: 'unrelated topic probe' })
      );
      expect(pack.open_loops.map((entry) => entry.id)).not.toContain(memory_id);

      // …but soft: still an ACTIVE memory a direct recall finds — the TTL
      // demotes the nag, it never closes or hides the loop itself.
      const recalled = await mcp.callTool('recall', {
        query: 'quokka export batch importer',
        k: 10,
        kinds: ['task'],
      });
      expect(recalled.isError ?? false).toBe(false);
      expect(contentText(recalled)).toContain(memory_id);

      // Closing still works on an aged-out loop. Leave the stack clean.
      const closed = await mcp.callTool('close_loop', { memory_id });
      expect(closed.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }
  });

  test('the content guard rejects a secret-bearing task (pointer, not payload)', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const token = `ghp_${'B'.repeat(36)}`;
      const result = await mcp.callTool('remember', {
        content: `check the deploy on machine B, it authenticates with ${token}`,
        kind: 'task',
        scope: 'personal',
      });
      expect(result.isError ?? false).toBe(true);
      const text = contentText(result);
      expect(text).toContain('secret_content_rejected');
      expect(text).not.toContain(token);
    } finally {
      await mcp.close();
    }
  });
});
