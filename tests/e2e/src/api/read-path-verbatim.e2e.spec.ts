/**
 * The read path searches with the string it was given. Nothing on the server
 * rewrites a query or a topic, so what a caller sent is what the search ran on
 * and what the activity log shows — the three can no longer disagree.
 *
 * The flags a previous contract used to carry (`translate_query`, `query_lang`)
 * are gone. An older client that still sends them must be no worse off than one
 * that does not, which is what the first test pins: they are stripped, not
 * honoured, and they change nothing.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

const EN_QUERY = 'what does the e2e fixture say about the dashboard feed?';
const NON_ENGLISH_QUERY =
  'e2eフィクスチャはダッシュボードのフィードについて何と言っていますか？';

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
    } finally {
      await mcp.close();
    }
  });

  test('@smoke a non-English query is answered without reporting a rewrite', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const recalled = await mcp.callTool('recall', {
        query: NON_ENGLISH_QUERY,
        k: 10,
      });

      expect(recalled.isError ?? false).toBe(false);
      // Whatever it finds against an English corpus is the caller's business;
      // what matters here is that the server answers without substituting a
      // query of its own.
      expect(firstJson<Record<string, unknown>>(recalled)).not.toHaveProperty(
        'searched_as'
      );
    } finally {
      await mcp.close();
    }
  });

  test('@smoke build_context briefs on the topic it was given, with its kind', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const pack = await mcp.callTool('build_context', {
        topic: NON_ENGLISH_QUERY,
        briefing: true,
        // The marker the server meters task briefings by — accepted on the
        // wire, and not a translation gate.
        briefing_kind: 'task',
        max_tokens: 1200,
      });

      expect(pack.isError ?? false).toBe(false);
      expect(firstJson<Record<string, unknown>>(pack)).not.toHaveProperty(
        'searched_as'
      );
    } finally {
      await mcp.close();
    }
  });
});
