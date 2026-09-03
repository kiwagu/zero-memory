/**
 * Section content caps end-to-end: a briefing inlines each section's content
 * only up to that section's cap and flags the row, so an over-long memory
 * costs a bounded number of tokens instead of its full body. What the caps
 * must NOT do is change WHICH memories a pack carries — the whole point is
 * that ranking is untouched and the rest of the text stays one id away.
 *
 * Isolated user: the fixture writes one very long memory and one open loop.
 */
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

interface PackRow {
  id: string;
  content: string;
  truncated?: boolean;
}

interface BriefingPack {
  memories: PackRow[];
  linked_memories: PackRow[];
  recent?: PackRow[];
  open_loops?: PackRow[];
}

/**
 * Server defaults, mirrored from the migrations that set them. The hits' cap
 * moved 1800 -> 2400 once the cost of the cut was measured: at 1800 about 1.5%
 * of the corpus lost an operative section the surviving head did not carry.
 */
const MEMORY_CAP = 2400;
const LOOP_CAP = 400;

/**
 * A body far past both caps, with a marker only the tail carries. The bulk is
 * built FROM the subject so two bodies never collapse into near-duplicates —
 * shared filler would be deduplicated on write and would make the ranking
 * between them arbitrary, testing neither.
 */
const longBody = (subject: string): string =>
  `${subject} — the decision and its reasoning. ` +
  `Evidence for "${subject}" recorded at the moment it was measured. `.repeat(
    40
  ) +
  'TAIL-MARKER-ONLY-IN-THE-FULL-TEXT';

test.describe('Briefing section caps over MCP', () => {
  test('an over-long hit arrives capped and flagged, and recall still returns it whole', async () => {
    const user = await provisionE2EUser('briefing-caps@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const topic = 'quorum handover protocol for the ledger writer';
      const remembered = await mcp.callTool('remember', {
        content: longBody(topic),
        kind: 'decision',
        scope: 'personal',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);

      const pack = firstJson<BriefingPack>(
        await mcp.callTool('build_context', { topic, briefing: true })
      );
      const hit = [...pack.memories, ...pack.linked_memories].find(
        (row) => row.id === memory_id
      );
      expect(
        hit,
        'the long memory should be in its own topic pack'
      ).toBeDefined();
      expect(hit?.truncated).toBe(true);
      expect(hit?.content.length).toBeLessThanOrEqual(MEMORY_CAP);
      // The cap trims text, it does not summarize: the head is verbatim.
      expect(hit?.content.startsWith(topic)).toBe(true);
      expect(hit?.content).not.toContain('TAIL-MARKER-ONLY-IN-THE-FULL-TEXT');

      // The rest is one id away — that is what makes the cap honest.
      const recalled = firstJson<{
        memories: Array<{ id: string; content: string }>;
      }>(await mcp.callTool('recall', { query: topic }));
      const full = recalled.memories.find((row) => row.id === memory_id);
      expect(full?.content).toContain('TAIL-MARKER-ONLY-IN-THE-FULL-TEXT');
    } finally {
      await mcp.close();
    }
  });

  test('an off-topic open loop is delivered as a reminder, not as its whole handover text', async () => {
    const user = await provisionE2EUser('briefing-caps-loop@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      // TWO loops, because the cap applies to the ones this briefing is not
      // about: the loop nearest the topic is inlined whole by design, so a
      // lone loop would always be the near one and could never show the cap.
      const topic = 'shard rebalancing rollout';
      const offTopic = 'winter tyre storage and rotation';
      const remembered = await mcp.callTool('remember', {
        content: longBody(offTopic),
        kind: 'task',
        scope: 'personal',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);
      const near = await mcp.callTool('remember', {
        content: longBody(topic),
        kind: 'task',
        scope: 'personal',
      });
      expect(near.isError ?? false).toBe(false);

      const pack = firstJson<BriefingPack>(
        await mcp.callTool('build_context', { topic, briefing: true })
      );
      const loop = (pack.open_loops ?? []).find((row) => row.id === memory_id);
      expect(
        loop,
        'an active loop belongs in every briefing of its scope, on topic or not'
      ).toBeDefined();
      expect(loop?.truncated).toBe(true);
      expect(loop?.content.length).toBeLessThanOrEqual(LOOP_CAP);
    } finally {
      await mcp.close();
    }
  });

  test('the caps change how much is inlined, never which memories arrive', async () => {
    const user = await provisionE2EUser('briefing-caps-ids@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const topic = 'retention policy for archived shipment events';
      // Deliberately DIFFERENT decisions on one topic: near-identical bodies
      // are deduplicated on write, which would make a count assertion here a
      // test of the deduplicator rather than of the caps.
      const facets = [
        'cold storage moves to object storage after ninety days',
        'the purge job runs weekly and never deletes disputed shipments',
        'replays rebuild an archived shipment from its event log alone',
      ];
      const written: string[] = [];
      for (const facet of facets) {
        const stored = await mcp.callTool('remember', {
          content: `${topic}: ${facet}. ${longBody(facet)}`,
          kind: 'decision',
          scope: 'personal',
        });
        expect(stored.isError ?? false).toBe(false);
        written.push(firstJson<{ memory_id: string }>(stored).memory_id);
      }
      const distinct = [...new Set(written)];

      const pack = firstJson<BriefingPack>(
        await mcp.callTool('build_context', { topic, briefing: true })
      );
      const rows = [...pack.memories, ...pack.linked_memories];
      const delivered = new Set(rows.map((row) => row.id));
      // Capping the bodies must not cost the pack a single id.
      for (const id of distinct) {
        expect(delivered.has(id), `${id} should still be delivered`).toBe(true);
      }
      // And every row is either whole or flagged — a silently cut body would
      // let a reader trust an incomplete fact as complete.
      for (const row of rows) {
        if (row.content.length >= MEMORY_CAP) {
          expect(row.truncated).toBe(true);
        }
      }
    } finally {
      await mcp.close();
    }
  });
});

test.afterAll(async () => {
  // The fixtures above write into isolated users; nothing shared to undo.
  void e2eEnv;
});
