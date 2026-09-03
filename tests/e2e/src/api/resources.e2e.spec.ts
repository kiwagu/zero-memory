/**
 * The MCP resources plane seen from outside: a real Streamable HTTP client
 * lists and dereferences zm:// resources against the e2e server. Covers the
 * three promises the plane makes — full-fidelity read by id, RLS as the
 * visibility boundary, and dereferenceable resource_link blocks on recall
 * hits — plus the prompts inventory.
 */
import { expect, test } from '@playwright/test';

import { McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

const memoryUri = (id: string): string => `zm://memory/${id}`;

test.describe('MCP resources plane', () => {
  test('@smoke owner reads a full memory by zm://memory/{id}; plane is listed', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const templates = await mcp.listResourceTemplateUris();
      expect(templates).toContain('zm://memory/{id}');

      const resources = await mcp.listResources();
      expect(resources.map((resource) => resource.uri)).toContain('zm://rules');

      const memory = await mcp.readResourceJson<{
        id: string;
        content: string;
        kind: string;
      }>(memoryUri(seed.rlsPrivateMemoryId));
      expect(memory.id).toBe(seed.rlsPrivateMemoryId);
      expect(memory.content.length).toBeGreaterThan(0);

      const prompts = await mcp.listPromptNames();
      expect(prompts.sort()).toEqual(['brief', 'receipt', 'triage']);
    } finally {
      await mcp.close();
    }
  });

  test('@smoke another user cannot dereference a foreign memory URI', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // RLS makes "absent" and "not yours" the same answer — the resource
      // read must not repair that distinction.
      await expect(
        mcp.readResourceJson(memoryUri(seed.rlsPrivateMemoryId))
      ).rejects.toThrow(/not found/i);
    } finally {
      await mcp.close();
    }
  });

  test('recall hits carry resource_link blocks that dereference to the full row', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const blocks = await mcp.callToolBlocks('recall', {
        query: 'which memory is visible only to e2e user A?',
        k: 5,
      });
      // The contract is structural — one link per hit, mirroring the JSON
      // payload — not that any particular memory ranks in the top k (the
      // full suite grows the corpus, so ranking of one seed is not stable).
      const hits = (
        JSON.parse(blocks[0]?.text ?? '{}') as {
          memories?: Array<{ id: string }>;
        }
      ).memories;
      expect(hits?.length ?? 0).toBeGreaterThan(0);

      const linkUris = blocks
        .filter((block) => block.type === 'resource_link')
        .map((block) => String(block.uri));
      expect(linkUris).toEqual((hits ?? []).map((hit) => memoryUri(hit.id)));

      const topHitId = String(hits?.[0]?.id);
      const full = await mcp.readResourceJson<{ id: string; content: string }>(
        memoryUri(topHitId)
      );
      expect(full.id).toBe(topHitId);
      expect(full.content.length).toBeGreaterThan(0);
    } finally {
      await mcp.close();
    }
  });
});
