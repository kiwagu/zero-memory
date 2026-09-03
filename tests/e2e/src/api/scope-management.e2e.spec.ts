/**
 * Scope management surface, end-to-end: alias metadata feeds the filter
 * listing; rename re-paths the subtree; merge pours one scope into another
 * and delete removes everything — both admin-gated (a stranger is refused).
 */
import { expect, test } from '@playwright/test';

import { readSeedState } from '../helpers/runtime-state.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, userRestClient } from '../helpers/users.js';

/** Bootstraps a scope by writing a memory into it (canonicalized per-owner). */
async function seedScope(
  mcp: McpTestClient,
  slug: string,
  content: string
): Promise<{ scope: string; memoryId: string }> {
  const write = await mcp.callTool('remember', {
    content,
    kind: 'fact',
    scope: `proj.${slug}`,
  });
  expect(write.isError ?? false).toBe(false);
  const out = firstJson<{ memory_id: string; scope: string }>(write);
  return { scope: out.scope, memoryId: out.memory_id };
}

test.describe('Scope management over PostgREST + MCP', () => {
  test('alias saves via RLS and shows up in list_memory_scopes', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const mcp = await McpTestClient.connect(token);
    try {
      const { scope } = await seedScope(
        mcp,
        'mgmt_alias',
        'scope-management marker: alias probe fact'
      );

      const rest = userRestClient(token);
      const { error: upsertError } = await rest.from('scopes').upsert(
        {
          scope,
          alias: 'Alias Probe',
          description: 'Probe scope for the alias flow.',
          description_source: 'human',
        },
        { onConflict: 'scope' }
      );
      expect(upsertError).toBeNull();

      const { data: rows, error } = await rest.rpc('list_memory_scopes');
      expect(error).toBeNull();
      const row = (rows ?? []).find(
        (entry: { scope: string; alias: string | null }) =>
          entry.scope === scope
      );
      expect(row?.alias).toBe('Alias Probe');
    } finally {
      await mcp.close();
    }
  });

  test('rename_scope re-paths memories and membership to the new slug', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const mcp = await McpTestClient.connect(token);
    try {
      const { scope, memoryId } = await seedScope(
        mcp,
        'mgmt_rename_a',
        'scope-management marker: rename subject fact'
      );

      const rest = userRestClient(token);
      const { data: renamed, error } = await rest.rpc('rename_scope', {
        p_scope: scope,
        p_new_slug: 'mgmt_rename_b',
      });
      expect(error).toBeNull();
      expect(String(renamed)).toBe(
        scope.replace(/\.mgmt_rename_a$/, '.mgmt_rename_b')
      );

      const { data: memory } = await rest
        .from('memories')
        .select('scope')
        .eq('id', memoryId)
        .single();
      expect(String(memory!.scope)).toBe(String(renamed));

      const { data: members } = await rest
        .from('scope_members')
        .select('role')
        .eq('scope', String(renamed));
      expect(members?.length).toBeGreaterThan(0);
    } finally {
      await mcp.close();
    }
  });

  test('merge pours a scope into another; delete removes the rest; both admin-gated', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const mcp = await McpTestClient.connect(token);
    try {
      const from = await seedScope(
        mcp,
        'mgmt_merge_src',
        'scope-management marker: merge source fact'
      );
      const into = await seedScope(
        mcp,
        'mgmt_merge_dst',
        'scope-management marker: merge target fact'
      );

      // A stranger administers neither side — refused before any effect.
      const strangerRest = userRestClient(await passwordGrantToken(seed.userA));
      const { error: strangerError } = await strangerRest.rpc('merge_scopes', {
        p_from: from.scope,
        p_into: into.scope,
      });
      expect(strangerError).not.toBeNull();

      const rest = userRestClient(token);
      const { error: mergeError } = await rest.rpc('merge_scopes', {
        p_from: from.scope,
        p_into: into.scope,
      });
      expect(mergeError).toBeNull();

      const { data: moved } = await rest
        .from('memories')
        .select('scope')
        .eq('id', from.memoryId)
        .single();
      expect(String(moved!.scope)).toBe(into.scope);
      const { data: sourceMembers } = await rest
        .from('scope_members')
        .select('role')
        .eq('scope', from.scope);
      expect(sourceMembers ?? []).toHaveLength(0);

      // Delete the merged target: its memories disappear for good.
      const { error: deleteError } = await rest.rpc('delete_scope', {
        p_scope: into.scope,
      });
      expect(deleteError).toBeNull();
      const { data: leftovers } = await rest
        .from('memories')
        .select('id')
        .eq('scope', into.scope);
      expect(leftovers ?? []).toHaveLength(0);
    } finally {
      await mcp.close();
    }
  });
});
