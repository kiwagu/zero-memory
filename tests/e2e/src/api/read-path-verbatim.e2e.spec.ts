/**
 * The flags a previous contract used to carry (`translate_query`, `query_lang`)
 * are gone. An older client that still sends them must be no worse off than one
 * that does not: over the wire they are stripped, not refused, and they change
 * nothing. That holds for both read tools; build_context is the one the older
 * session-start hooks sent them on, and it no longer reports a rewritten
 * `searched_as` either. (That the server searches the string it was given,
 * unrewritten, is the memory service's unit tests' to pin: they see what
 * reaches the embedder.)
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

const EN_QUERY = 'what does the e2e fixture say about the dashboard feed?';

test.describe('the read path searches verbatim over MCP', () => {
  test('@smoke a retired translation flag is ignored, not honoured', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const plain = await mcp.callTool('recall', { query: EN_QUERY, k: 10 });
      const stale = await mcp.callTool('recall', {
        query: EN_QUERY,
        k: 10,
        translate_query: true,
        query_lang: 'ja',
      });

      expect(plain.isError ?? false).toBe(false);
      expect(stale.isError ?? false).toBe(false);
      const idsOf = (result: typeof plain): string[] =>
        firstJson<{ memories: Array<{ id: string }> }>(result).memories.map(
          (memory) => memory.id
        );
      expect(idsOf(stale)).toEqual(idsOf(plain));

      const plainPack = await mcp.callTool('build_context', {
        topic: EN_QUERY,
      });
      const stalePack = await mcp.callTool('build_context', {
        topic: EN_QUERY,
        translate_query: true,
        query_lang: 'ja',
      });

      expect(plainPack.isError ?? false).toBe(false);
      expect(stalePack.isError ?? false).toBe(false);
      expect(firstJson<Record<string, unknown>>(stalePack)).not.toHaveProperty(
        'searched_as'
      );
      // The premise: the pack found something, so equal ids are a comparison.
      expect(idsOf(plainPack).length).toBeGreaterThan(0);
      expect(idsOf(stalePack)).toEqual(idsOf(plainPack));
    } finally {
      await mcp.close();
    }
  });
});
