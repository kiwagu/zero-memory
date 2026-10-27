/**
 * Briefing-pack hygiene end-to-end: the linked leg of build_context is
 * ranked (scored, ordered, episode-free) with over-long content truncated
 * under a flag; duplicate entities collapse into one display row carrying
 * their types and member count; and edges between duplicates of the same
 * canonical name (self-loops) never reach the pack.
 *
 * Isolated user: the fixtures write episodes and duplicate entities, which
 * must not shift the shared seed users' recall pools mid-suite.
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

interface PackMemory {
  id: string;
  kind: string;
  content: string;
  score?: number;
  truncated?: boolean;
}

interface BriefingPack {
  memories: PackMemory[];
  linked_memories: PackMemory[];
  entities: Array<{
    id: string;
    name: string;
    type: string;
    types?: string[];
    count?: number;
  }>;
  edges: Array<{ src: string; dst: string; type: string; weight?: number }>;
}

/** The canonical topic entity every fixture mentions. */
const ENTITY = 'quokka-briefer';

test.describe('Briefing pack hygiene over MCP', () => {
  test('linked leg is ranked and episode-free, long content is truncated with a flag', async () => {
    const user = await provisionE2EUser('briefing-hygiene@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const remember = async (
        content: string,
        kind: string
      ): Promise<string> => {
        const result = await mcp.callTool('remember', {
          content,
          kind,
          entities: [{ name: ENTITY, type: 'tool' }],
          scope: 'personal',
        });
        expect(result.isError ?? false).toBe(false);
        return firstJson<{ memory_id: string }>(result).memory_id;
      };

      // The direct topic hits. A small budget (max_tokens 600 → three ranked
      // rows) and three hits that match the topic outright fill the ranked
      // leg, so everything below can only arrive through the entity walk.
      const hits: string[] = [];
      for (const detail of [
        'renders the session briefing header for the dashboard',
        'caches the session briefing header per project for a minute',
        'localizes the session briefing header into the reader language',
      ]) {
        hits.push(await remember(`${ENTITY} ${detail}`, 'fact'));
      }
      // …an off-topic gotcha that shares only the entity…
      const linkedId = await remember(
        'the export scheduler retries five times before giving up on a stalled job',
        'gotcha'
      );
      // …an episode mentioning the same entity: episodes must never ride the
      // linked leg (transient fragments were half the pack before v2)…
      const episodeId = await remember(
        'current discussion is aimed at reworking the export scheduler retries',
        'episode'
      );
      // …and an off-topic decision far above the linked leg's cap (600).
      const longContent = `chose the queue-based importer over inline processing because ${'the batch window keeps the write path idle and the retry ledger stays small; '.repeat(12)}`;
      const longId = await remember(longContent, 'decision');

      const pack = firstJson<BriefingPack>(
        await mcp.callTool('build_context', {
          topic: `${ENTITY} session briefing header`,
          max_tokens: 600,
        })
      );

      // The premise: the ranked leg holds the topic hits and nothing else, so
      // what the linked leg carries, or leaves out, is its own doing.
      expect(pack.memories.map((memory) => memory.id).sort()).toEqual(
        [...hits].sort()
      );

      const linked = pack.linked_memories.map((memory) => memory.id);
      expect(linked, 'entity-linked knowledge must be in the pack').toEqual(
        expect.arrayContaining([linkedId, longId])
      );
      expect(linked, 'episodes must not ride the linked leg').not.toContain(
        episodeId
      );

      // Ranked leg: every linked entry carries a score, ordered descending.
      const scores = pack.linked_memories.map((memory) => memory.score);
      expect(scores.every((score) => typeof score === 'number')).toBe(true);
      expect([...scores].sort((a, b) => b! - a!)).toEqual(scores);

      // Over-long content is capped under an explicit flag, verbatim from the
      // head; the full text stays one recall away by id.
      const longEntry = pack.linked_memories.find(
        (memory) => memory.id === longId
      );
      expect(longEntry?.truncated).toBe(true);
      expect(longEntry?.content).toBe(longContent.slice(0, 600));
    } finally {
      await mcp.close();
    }
  });

  test('duplicate entities collapse into one row and self-loop edges are dropped', async () => {
    const user = await provisionE2EUser('briefing-hygiene@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      // HISTORICAL duplicates, seeded service-role: the write path now
      // resolves same-name entities onto one node (match-before-create), so
      // the pre-fix corpus shape — two spellings of one canonical name under
      // different types, plus an edge between them — can only exist as data
      // written before that fix. The render collapse targets exactly that.
      const admin = adminClient();
      const { data: profile, error: profileError } = await admin
        .from('profiles')
        .select('id')
        .eq('user_id', user.id)
        .single();
      expect(profileError).toBeNull();
      const ownerId = (profile as { id: string }).id;
      const ownerScope = `user.${ownerId.replace('.', '_')}`;

      const { data: memoryRow, error: memoryError } = await admin
        .from('memories')
        .insert({
          content:
            'quokka importer writes its ledger through the quokka_importer queue',
          kind: 'fact',
          scope: ownerScope,
          owner_id: ownerId,
        })
        .select('id')
        .single();
      expect(memoryError).toBeNull();

      const { data: entityRows, error: entityError } = await admin
        .from('entities')
        .insert([
          {
            name: 'quokka-importer',
            type: 'service',
            scope: ownerScope,
            created_by: ownerId,
          },
          {
            name: 'quokka_importer',
            type: 'repo',
            scope: ownerScope,
            created_by: ownerId,
          },
        ])
        .select('id');
      expect(entityError).toBeNull();
      const [first, second] = entityRows as Array<{ id: string }>;

      const { error: mentionError } = await admin
        .from('memory_entities')
        .insert([
          { memory_id: (memoryRow as { id: string }).id, entity_id: first!.id },
          {
            memory_id: (memoryRow as { id: string }).id,
            entity_id: second!.id,
          },
        ]);
      expect(mentionError).toBeNull();

      // The edge between the two duplicates: canonically a self-loop.
      const { error: edgeError } = await admin.from('edges').insert({
        src: first!.id,
        dst: second!.id,
        type: 'relates_to',
        scope: ownerScope,
        created_by: ownerId,
      });
      expect(edgeError).toBeNull();

      // Topic phrased to hit the seeded memory through the text leg (the
      // service-role fixture rows carry no embeddings): the memory hit then
      // pulls both duplicate entities into the pack via its mentions.
      const pack = firstJson<BriefingPack>(
        await mcp.callTool('build_context', {
          topic: 'quokka importer ledger queue',
        })
      );

      const norm = (name: string): string =>
        name.toLowerCase().replace(/[_\s-]+/g, '-');
      const rows = pack.entities.filter(
        (entity) => norm(entity.name) === 'quokka-importer'
      );
      expect(rows, 'duplicates must collapse to one display row').toHaveLength(
        1
      );
      expect(rows[0]!.count).toBeGreaterThanOrEqual(2);
      expect(rows[0]!.types).toEqual(
        expect.arrayContaining(['repo', 'service'])
      );

      // No edge whose endpoints collapse to the same canonical name.
      const selfLoops = pack.edges.filter(
        (edge) => norm(edge.src) === norm(edge.dst)
      );
      expect(selfLoops).toEqual([]);
    } finally {
      await mcp.close();
    }
  });
});
