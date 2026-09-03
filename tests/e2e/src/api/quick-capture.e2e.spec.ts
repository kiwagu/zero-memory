/**
 * Quick-capture write path end-to-end: a headless `remember` carrying a
 * `project_hint` (the CLI sends its cwd) lands in the project scope resolved
 * by the server's project bindings — no MCP roots handshake involved — and
 * the response reports the landing scope. A `--task` capture becomes an open
 * loop that surfaces in the next briefing until closed.
 */
import { expect, test } from '@playwright/test';

import { readSeedState } from '../helpers/runtime-state.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken } from '../helpers/users.js';

interface Remembered {
  memory_id: string;
  deduplicated?: boolean;
  scope?: string;
}

test.describe('Quick-capture over MCP @smoke', () => {
  test('a project_hint routes the write to the project scope, deterministically', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const remembered = await mcp.callTool('remember', {
        content:
          'e2e quick-capture marker: the quokka importer batches uploads ' +
          'in groups of 50',
        project_hint: '/home/someone/repos/quokka-capture-e2e',
      });
      expect(remembered.isError ?? false).toBe(false);
      const result = firstJson<Remembered>(remembered);
      expect(result.scope).toMatch(/^proj\./);
      expect(result.scope).toContain('quokka');

      // The fact is recallable from the scope the response reported.
      const recalled = await mcp.callTool('recall', {
        query: 'how does the quokka importer batch uploads?',
        scopes: [result.scope!],
        k: 5,
      });
      expect(recalled.isError ?? false).toBe(false);
      const hits = firstJson<{ memories: Array<{ id: string }> }>(recalled);
      expect(hits.memories.map((m) => m.id)).toContain(result.memory_id);

      // Idempotent transport: the same capture dedups to the same memory and
      // still reports where it lives.
      const again = firstJson<Remembered>(
        await mcp.callTool('remember', {
          content:
            'e2e quick-capture marker: the quokka importer batches uploads ' +
            'in groups of 50',
          project_hint: '/home/someone/repos/quokka-capture-e2e',
        })
      );
      expect(again.memory_id).toBe(result.memory_id);
      expect(again.deduplicated).toBe(true);
      expect(again.scope).toBe(result.scope);
    } finally {
      await mcp.close();
    }
  });

  test('a --task capture is an open loop in the project briefing until closed', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const remembered = await mcp.callTool('remember', {
        content:
          'e2e quick-capture marker: re-run the quokka import once the ' +
          'batch size fix ships',
        kind: 'task',
        project_hint: '/home/someone/repos/quokka-capture-e2e',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id, scope } = firstJson<Remembered>(remembered);

      const briefing = firstJson<{
        open_loops: Array<{ id: string; kind: string }>;
      }>(
        await mcp.callTool('build_context', {
          topic: 'anything unrelated',
          scopes: [scope!],
        })
      );
      const loop = briefing.open_loops.find((entry) => entry.id === memory_id);
      expect(loop, 'captured task must surface as an open loop').toBeTruthy();
      expect(loop!.kind).toBe('task');

      // Leave the stack clean.
      const closed = await mcp.callTool('close_loop', { memory_id });
      expect(closed.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }
  });

  test('an explicit scope wins over the project hint', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const result = firstJson<Remembered>(
        await mcp.callTool('remember', {
          content:
            'e2e quick-capture marker: bun compiled binaries dispatch ' +
            'subcommands on argv[2], never argv0',
          kind: 'gotcha',
          scope: 'core',
          project_hint: '/home/someone/repos/quokka-capture-e2e',
        })
      );
      expect(result.scope).toMatch(/\.core$/);
    } finally {
      await mcp.close();
    }
  });
});
