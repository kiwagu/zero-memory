/**
 * Entity merge end-to-end: the atomic merge_entities RPC collapses a
 * duplicate cluster — mentions repointed, edges repointed with would-be
 * self-loops dropped, dominant type applied, duplicate nodes deleted — and
 * the briefing graph stays connected through the canonical node afterwards.
 *
 * Fixtures are seeded service-role: duplicate entities are historical data
 * (the write path stopped creating them), exactly what the hygiene pass
 * cleans up.
 */
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

const adminClient = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

interface BriefingPack {
  memories: Array<{ id: string }>;
  linked_memories: Array<{ id: string }>;
  entities: Array<{ id: string; name: string; count?: number }>;
  edges: Array<{ src: string; dst: string; type: string }>;
}

test('merge_entities collapses a duplicate cluster and the graph stays connected', async () => {
  const user = await provisionE2EUser('entity-merge@zm.e2e');
  const admin = adminClient();

  const { data: profile } = await admin
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single();
  const ownerId = (profile as { id: string }).id;
  const ownerScope = `user.${ownerId.replace('.', '_')}`;

  // Historical duplicates: three spellings of one canonical name, plus a
  // genuinely different node the edges connect to.
  const { data: entities, error: entityError } = await admin
    .from('entities')
    .insert([
      {
        name: 'walrus-sync',
        type: 'service',
        scope: ownerScope,
        created_by: ownerId,
      },
      {
        name: 'walrus_sync',
        type: 'repo',
        scope: ownerScope,
        created_by: ownerId,
      },
      {
        name: 'Walrus Sync',
        type: 'repo',
        scope: ownerScope,
        created_by: ownerId,
      },
      {
        name: 'postgres',
        type: 'tool',
        scope: ownerScope,
        created_by: ownerId,
      },
    ])
    .select('id, name');
  expect(entityError).toBeNull();
  const byName = new Map(
    (entities as Array<{ id: string; name: string }>).map((row) => [
      row.name,
      row.id,
    ])
  );
  const canonical = byName.get('walrus-sync')!;
  const dupA = byName.get('walrus_sync')!;
  const dupB = byName.get('Walrus Sync')!;
  const postgres = byName.get('postgres')!;

  // Two memories, each mentioning a different duplicate.
  const { data: memories, error: memoryError } = await admin
    .from('memories')
    .insert([
      {
        content: 'walrus sync ships its ledger nightly',
        kind: 'fact',
        scope: ownerScope,
        owner_id: ownerId,
      },
      {
        content: 'walrus sync stores state in postgres',
        kind: 'fact',
        scope: ownerScope,
        owner_id: ownerId,
      },
    ])
    .select('id');
  expect(memoryError).toBeNull();
  const [memA, memB] = memories as Array<{ id: string }>;

  const { error: mentionError } = await admin.from('memory_entities').insert([
    { memory_id: memA!.id, entity_id: dupA },
    { memory_id: memB!.id, entity_id: dupB },
    // One memory already mentions the canonical too: the repoint must not
    // trip over the existing row.
    { memory_id: memA!.id, entity_id: canonical },
  ]);
  expect(mentionError).toBeNull();

  const { error: edgeError } = await admin.from('edges').insert([
    // Edge between two duplicates: becomes a self-loop, must be dropped.
    {
      src: dupA,
      dst: dupB,
      type: 'relates_to',
      scope: ownerScope,
      created_by: ownerId,
    },
    // Real relation from a duplicate: must survive on the canonical.
    {
      src: dupB,
      dst: postgres,
      type: 'uses',
      scope: ownerScope,
      created_by: ownerId,
    },
  ]);
  expect(edgeError).toBeNull();

  // The merge under test (dominant type across the cluster is 'repo').
  const { data: counters, error: mergeError } = await admin.rpc(
    'merge_entities',
    { p_canonical: canonical, p_duplicates: [dupA, dupB], p_type: 'repo' }
  );
  expect(mergeError).toBeNull();
  expect(counters).toMatchObject({ duplicates_deleted: 2 });

  // Duplicates gone; canonical retyped.
  const { data: leftover } = await admin
    .from('entities')
    .select('id, type')
    .in('id', [canonical, dupA, dupB]);
  expect(leftover).toHaveLength(1);
  expect((leftover as Array<{ id: string; type: string }>)[0]).toMatchObject({
    id: canonical,
    type: 'repo',
  });

  // Mentions repointed: both memories now mention the canonical.
  const { data: mentions } = await admin
    .from('memory_entities')
    .select('memory_id')
    .eq('entity_id', canonical);
  expect(
    (mentions as Array<{ memory_id: string }>)
      .map((row) => row.memory_id)
      .sort()
  ).toEqual([memA!.id, memB!.id].sort());

  // Edges: the real relation survived on the canonical, no self-loops.
  const { data: edges } = await admin
    .from('edges')
    .select('src, dst, type')
    .or(`src.eq.${canonical},dst.eq.${canonical}`)
    .is('invalidated_at', null);
  expect(edges).toEqual([{ src: canonical, dst: postgres, type: 'uses' }]);

  // The briefing walks the merged graph: one entity row for the name, the
  // linked leg reaches both memories through the canonical node.
  const mcp = await McpTestClient.connect(await passwordGrantToken(user));
  try {
    const pack = firstJson<BriefingPack>(
      await mcp.callTool('build_context', {
        topic: 'walrus sync ledger nightly',
      })
    );
    const walrusRows = pack.entities.filter((entity) =>
      entity.name.toLowerCase().includes('walrus')
    );
    expect(walrusRows).toHaveLength(1);
    const packIds = [...pack.memories, ...pack.linked_memories].map(
      (memory) => memory.id
    );
    expect(packIds).toEqual(expect.arrayContaining([memA!.id, memB!.id]));
  } finally {
    await mcp.close();
  }
});
