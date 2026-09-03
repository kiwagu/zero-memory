/**
 * Global setup: provisions the two dedicated e2e users (idempotent, guarded
 * to the @zm.e2e domain) and seeds user A's deterministic fixture memories
 * through the public MCP surface. `remember` deduplication makes reseeding
 * a no-op on repeat runs, so the fixture set never grows.
 */
import {
  FIXTURE_MEMORIES,
  RLS_PRIVATE_MEMORY,
} from './helpers/fixture-memories.js';
import { firstJson, McpTestClient } from './helpers/mcp.js';
import { writeSeedState } from './helpers/runtime-state.js';
import { passwordGrantToken, provisionE2EUser } from './helpers/users.js';
import { e2eEnv } from './helpers/env.js';

async function globalSetup(): Promise<void> {
  const [userA, userB] = await Promise.all([
    provisionE2EUser(e2eEnv.userAEmail),
    provisionE2EUser(e2eEnv.userBEmail),
  ]);

  const tokenA = await passwordGrantToken(userA);
  const mcp = await McpTestClient.connect(tokenA);
  try {
    const fixtureMemoryIds: Record<string, string> = {};
    for (const fixture of FIXTURE_MEMORIES) {
      const result = await mcp.callTool('remember', {
        content: fixture.content,
        kind: fixture.kind,
        ...(fixture.verbatim ? { verbatim: fixture.verbatim } : {}),
        scope: 'personal',
      });
      if (result.isError) {
        throw new Error(
          `Seeding fixture memory failed: ${result.content[0]?.text}`
        );
      }
      fixtureMemoryIds[fixture.content] = firstJson<{ memory_id: string }>(
        result
      ).memory_id;
    }

    const rlsResult = await mcp.callTool('remember', {
      content: RLS_PRIVATE_MEMORY.content,
      kind: RLS_PRIVATE_MEMORY.kind,
      scope: 'personal',
    });
    if (rlsResult.isError) {
      throw new Error(
        `Seeding RLS fixture memory failed: ${rlsResult.content[0]?.text}`
      );
    }

    await writeSeedState({
      userA,
      userB,
      fixtureMemoryIds,
      rlsPrivateMemoryId: firstJson<{ memory_id: string }>(rlsResult).memory_id,
    });
  } finally {
    await mcp.close();
  }
}

export default globalSetup;
