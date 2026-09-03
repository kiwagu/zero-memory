/**
 * Lazy re-verification (S2a): a recall hit that belongs to the FAST layer —
 * core-scope world knowledge — and has not been checked against an external
 * source within its per-kind budget comes back marked with `stale_days`, so
 * the session that actually needs the fact re-checks it in passing.
 *
 * The marker is delivery, not judgement: ranking is untouched and the fact
 * still stands. The control case matters as much as the marked one — a
 * project-scoped memory of the same age must NEVER be marked, because its
 * oracle is the project's own reality and its content must not travel to an
 * external lookup.
 */
import { expect, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

interface RememberOutput {
  memory_id: string;
}

interface RecallOutput {
  memories: Array<{ id: string; stale_days: number | null }>;
}

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Age a memory past any freshness budget, service-role. */
const ageMemory = async (
  client: SupabaseClient,
  memoryId: string,
  days: number
): Promise<void> => {
  const when = new Date(Date.now() - days * 86_400_000).toISOString();
  const { error } = await client
    .from('memories')
    .update({ created_at: when })
    .eq('id', memoryId);
  if (error) {
    throw new Error(`ageing ${memoryId} failed: ${error.message}`);
  }
};

const hitFor = (result: RecallOutput, memoryId: string) =>
  result.memories.find((memory) => memory.id === memoryId);

test.describe('staleness marker on recall', () => {
  test('an old core-scope fact is marked; a project-scoped one of the same age is not', async () => {
    const user = await provisionE2EUser('staleness-marker@zm.e2e');
    const token = await passwordGrantToken(user);
    const admin = adminClient();
    const mcp = await McpTestClient.connect(token);
    try {
      const core = firstJson<RememberOutput>(
        await mcp.callTool('remember', {
          content:
            'The zephyrlint formatter reads its config from zephyrlint.toml ' +
            'at the repository root.',
          kind: 'fact',
          scope: 'core',
        })
      );
      const project = firstJson<RememberOutput>(
        await mcp.callTool('remember', {
          content:
            'This service pins zephyrlint in CI so formatting never drifts ' +
            'between contributors.',
          kind: 'fact',
          scope: 'personal',
        })
      );

      // Both far past the fact budget (180 days).
      await ageMemory(admin, core.memory_id, 400);
      await ageMemory(admin, project.memory_id, 400);

      const recalled = firstJson<RecallOutput>(
        await mcp.callTool('recall', { query: 'zephyrlint formatter config' })
      );

      const coreHit = hitFor(recalled, core.memory_id);
      expect(coreHit, 'the core-scope fact should be recalled').toBeDefined();
      expect(coreHit!.stale_days).toBeGreaterThanOrEqual(400);

      const projectHit = hitFor(recalled, project.memory_id);
      if (projectHit) {
        // The control: same age, never marked — its truth is not external.
        expect(projectHit.stale_days).toBeNull();
      }
    } finally {
      await mcp.close();
    }
  });

  test('a freshly verified core fact is not marked despite its age', async () => {
    const user = await provisionE2EUser('staleness-verified@zm.e2e');
    const token = await passwordGrantToken(user);
    const admin = adminClient();
    const mcp = await McpTestClient.connect(token);
    try {
      const { memory_id: memoryId } = firstJson<RememberOutput>(
        await mcp.callTool('remember', {
          content:
            'The quillgraph CLI ships its schema migrations inside the binary.',
          kind: 'fact',
          scope: 'core',
        })
      );
      await ageMemory(admin, memoryId, 400);

      // A check recorded yesterday resets the clock — freshness is measured
      // from the last check, not from creation.
      const { error } = await admin.from('memory_verification').insert({
        memory_id: memoryId,
        last_verified_at: new Date(Date.now() - 86_400_000).toISOString(),
        verdict: 'current',
        verified_by_model: 'e2e',
      });
      expect(error).toBeNull();

      const recalled = firstJson<RecallOutput>(
        await mcp.callTool('recall', { query: 'quillgraph CLI migrations' })
      );
      const hit = hitFor(recalled, memoryId);
      expect(hit, 'the verified fact should be recalled').toBeDefined();
      expect(hit!.stale_days).toBeNull();
    } finally {
      await mcp.close();
    }
  });
});
