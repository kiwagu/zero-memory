/**
 * MCP over HTTP, protocol level: the streamable transport requires a valid
 * Supabase JWT, exposes the memory tools, and the remember → recall →
 * build_context loop works end-to-end against the live stack.
 */
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { FIXTURE_MEMORIES } from '../helpers/fixture-memories.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

test.describe('MCP over HTTP', () => {
  test('@smoke rejects requests without a bearer token', async ({
    request,
  }) => {
    const response = await request.post(`${e2eEnv.serverUrl}/mcp`, {
      data: { jsonrpc: '2.0', method: 'initialize', id: 1 },
    });
    expect(response.status()).toBe(401);
    expect(response.headers()['www-authenticate']).toContain(
      'resource_metadata'
    );
  });

  test('@smoke lists the memory tools for an authenticated session', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const tools = await mcp.listToolNames();
      for (const tool of ['remember', 'recall', 'build_context', 'share']) {
        expect(tools).toContain(tool);
      }
    } finally {
      await mcp.close();
    }
  });

  test('@smoke recall and build_context surface the seeded fixture memories', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const fixture = FIXTURE_MEMORIES[0]!;
      const fixtureId = seed.fixtureMemoryIds[fixture.content]!;

      const recalled = await mcp.callTool('recall', {
        query: 'what does the e2e fixture say about the dashboard feed?',
        k: 10,
      });
      expect(recalled.isError ?? false).toBe(false);
      expect(contentText(recalled)).toContain(fixtureId);

      const briefing = await mcp.callTool('build_context', {
        topic: 'e2e fixture dashboard',
      });
      expect(briefing.isError ?? false).toBe(false);
      const body = firstJson<{
        memories: Array<{ id: string }>;
        linked_memories: Array<{ id: string }>;
      }>(briefing);
      const ids = new Set(
        [...body.memories, ...body.linked_memories].map((memory) => memory.id)
      );
      expect(
        Object.values(seed.fixtureMemoryIds).some((id) => ids.has(id)),
        'build_context briefing must include at least one fixture memory'
      ).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  test('@smoke Codex receives decodable recall and build_context results', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA),
      'codex-vscode'
    );
    try {
      for (const call of [
        {
          name: 'recall',
          args: { query: 'e2e fixture dashboard', k: 5 },
        },
        {
          name: 'build_context',
          args: { topic: 'e2e fixture dashboard' },
        },
      ]) {
        const result = await mcp.callTool(call.name, call.args);
        expect(result.isError ?? false).toBe(false);
        expect(result.content[0]?.type).toBe('text');
        const links = result.content.filter(
          (block) => block.type === 'resource_link'
        );
        expect(links.length).toBeGreaterThan(0);
        for (const link of links) {
          expect([0, 1]).toContain(link.annotations?.priority);
        }
        expect(
          firstJson<{ memories: unknown[] }>(result).memories.length
        ).toBeGreaterThan(0);
      }
    } finally {
      await mcp.close();
    }
  });

  test('@smoke link resolves entities to entity-id endpoints (entityRef path)', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      // First link creates both nodes; the second resolves an EXISTING node
      // (findByNormalizedName → entityRefSchema.parse), the path that broke
      // when entity ids became ent_ but the ref schema still expected a uuid.
      const first = await mcp.callTool('link', {
        src: 'e2e alpha service',
        dst: 'e2e beta service',
        type: 'depends_on',
      });
      expect(first.isError ?? false).toBe(false);

      const second = await mcp.callTool('link', {
        src: 'e2e alpha service',
        dst: 'e2e gamma service',
        type: 'depends_on',
      });
      expect(second.isError ?? false).toBe(false);
      const body = firstJson<{
        kind: string;
        src_id: string;
        dst_id: string;
      }>(second);
      expect(body.kind).toBe('entity_edge');
      expect(body.src_id).toMatch(/^ent_/);
      expect(body.dst_id).toMatch(/^ent_/);
    } finally {
      await mcp.close();
    }
  });

  test('@smoke remember deduplicates an identical fixture memory', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const fixture = FIXTURE_MEMORIES[0]!;
      const result = await mcp.callTool('remember', {
        content: fixture.content,
        kind: fixture.kind,
        scope: 'personal',
      });
      expect(result.isError ?? false).toBe(false);
      const body = firstJson<{ memory_id: string; deduplicated?: boolean }>(
        result
      );
      expect(body.memory_id).toBe(seed.fixtureMemoryIds[fixture.content]);
    } finally {
      await mcp.close();
    }
  });

  test('@smoke remember rejects content carrying a known secret format', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const token = `ghp_${'A'.repeat(36)}`;
      const result = await mcp.callTool('remember', {
        content: `the ci deploy uses ${token} for pushes`,
        scope: 'personal',
      });
      expect(result.isError ?? false).toBe(true);
      const text = contentText(result);
      expect(text).toContain('secret_content_rejected');
      // The rejection must never echo the secret back.
      expect(text).not.toContain(token);
    } finally {
      await mcp.close();
    }
  });

  test('restore_memory revives an invalidated memory so recall surfaces it again', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const remembered = await mcp.callTool('remember', {
        content:
          'e2e restore-flow marker: the aurora gateway timeout is caused by ' +
          'the keepalive probe interval, not by the upstream pool size',
        kind: 'gotcha',
        scope: 'personal',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);

      const forgotten = await mcp.callTool('forget', { memory_id });
      expect(forgotten.isError ?? false).toBe(false);

      const restored = await mcp.callTool('restore_memory', { memory_id });
      expect(restored.isError ?? false).toBe(false);
      expect(firstJson<{ restored: boolean }>(restored).restored).toBe(true);

      const recalled = await mcp.callTool('recall', {
        query: 'what causes the aurora gateway timeout?',
        k: 10,
      });
      expect(recalled.isError ?? false).toBe(false);
      expect(contentText(recalled)).toContain(memory_id);

      // Restoring a live memory is a clean error, not a silent no-op.
      const again = await mcp.callTool('restore_memory', { memory_id });
      expect(again.isError ?? false).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  test('remember rejects a secret riding in the verbatim anchor', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const result = await mcp.callTool('remember', {
        content: 'the database credentials were rotated today',
        verbatim: '新しいDSN postgres://zm:sup3rs3cret@db.internal/zm',
        scope: 'personal',
      });
      expect(result.isError ?? false).toBe(true);
      expect(contentText(result)).toContain('secret_content_rejected');
    } finally {
      await mcp.close();
    }
  });
});
