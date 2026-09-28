/**
 * Quick-capture write path end-to-end: a headless `remember` carrying a
 * `project_hint` (the CLI sends its cwd) lands in the project scope resolved
 * by the server's project bindings — no MCP roots handshake involved — and
 * the response reports the landing scope.
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
});
