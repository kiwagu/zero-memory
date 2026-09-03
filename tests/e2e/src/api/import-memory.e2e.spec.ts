/**
 * Bootstrap-import over MCP: the deterministic `import_memory` tool stores a
 * native memory in the routed scope with `source.kind = "import"` provenance,
 * is idempotent per `source_hash` (re-import is a no-op), and routes personal
 * vs project targets correctly. This is the client-facing critical flow the
 * watcher's `import` subcommand drives.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken, userRestClient } from '../helpers/users.js';

interface ImportOutput {
  skipped: boolean;
  memory_id?: string;
  deduplicated?: boolean;
}

interface RecallHit {
  id: string;
  content: string;
  scope: string;
  kind: string;
}

test.describe('import_memory over MCP', () => {
  test('@smoke imports into routed scopes with import provenance and is idempotent', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const mcp = await McpTestClient.connect(token);
    try {
      expect(await mcp.listToolNames()).toContain('import_memory');

      // --- personal target ---------------------------------------------------
      const personalArgs = {
        content: 'IMPORT-E2E personal: the owner prefers Bun over npm scripts.',
        kind: 'preference',
        target: 'personal',
        source_tool: 'claude-code',
        source_path: '/home/e2e/.claude/projects/x/memory/pref.md',
        source_hash: 'e2e-import-personal-0001',
      };

      const first = firstJson<ImportOutput>(
        await mcp.callTool('import_memory', personalArgs)
      );
      expect(first.skipped).toBe(false);
      expect(first.memory_id).toBeTruthy();

      // Idempotent re-run: identical source_hash → skipped, no new row.
      const again = firstJson<ImportOutput>(
        await mcp.callTool('import_memory', personalArgs)
      );
      expect(again.skipped).toBe(true);

      // Provenance is stamped server-side (not from client input).
      const rest = userRestClient(token);
      const { data: row } = await rest
        .from('memories')
        .select('source, scope')
        .eq('id', first.memory_id!)
        .single();
      const source = (row?.source ?? {}) as Record<string, unknown>;
      expect(source.kind).toBe('import');
      expect(source.tool).toBe('claude-code');
      expect(String(row?.scope)).toMatch(/^user\./);

      // Recall surfaces it with the personal scope + mapped kind.
      const recalled = firstJson<{ memories: RecallHit[] }>(
        await mcp.callTool('recall', {
          query: 'owner prefers Bun over npm',
          k: 10,
        })
      );
      const hit = recalled.memories.find((m) =>
        m.content.includes('IMPORT-E2E personal')
      );
      expect(hit, 'imported personal memory must be recallable').toBeTruthy();
      expect(hit!.scope).toMatch(/^user\./);
      expect(hit!.kind).toBe('preference');

      // --- project target ----------------------------------------------------
      const projectOut = firstJson<ImportOutput>(
        await mcp.callTool('import_memory', {
          content:
            'IMPORT-E2E project: alpha-import uses Supabase for storage.',
          kind: 'decision',
          target: 'project',
          project_hint: '/home/e2e/repos/alpha-import',
          source_tool: 'claude-code',
          source_path: '/home/e2e/.claude/projects/alpha/memory/dec.md',
          source_hash: 'e2e-import-project-0001',
        })
      );
      expect(projectOut.skipped).toBe(false);

      const recalledProject = firstJson<{ memories: RecallHit[] }>(
        await mcp.callTool('recall', {
          query: 'alpha-import uses Supabase for storage',
          scopes: ['*'],
          k: 10,
        })
      );
      const projectHit = recalledProject.memories.find((m) =>
        m.content.includes('IMPORT-E2E project')
      );
      expect(
        projectHit,
        'imported project memory must be recallable'
      ).toBeTruthy();
      expect(projectHit!.scope).toMatch(/^proj\./);
    } finally {
      await mcp.close();
    }
  });
});
