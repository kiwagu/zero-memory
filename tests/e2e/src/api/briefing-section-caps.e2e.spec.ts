/**
 * Section content caps end-to-end: a briefing inlines each section's content
 * only up to that section's cap and flags the row, so an over-long memory
 * costs a bounded number of tokens instead of its full body. What the caps
 * must NOT do is change WHICH memories a pack carries — the whole point is
 * that ranking is untouched and the rest of the text stays one id away.
 *
 * Isolated user: the fixture writes three very long memories on one topic.
 * The open-loops section's caps are pinned where its depth is decided, in the
 * open-loop focus spec.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

interface PackRow {
  id: string;
  content: string;
  truncated?: boolean;
}

interface BriefingPack {
  memories: PackRow[];
}

/**
 * The hits' cap, the server default mirrored from the migration that set it.
 * It moved 1800 -> 2400 once the cost of the cut was measured: at 1800 about
 * 1.5% of the corpus lost an operative section the surviving head did not
 * carry.
 */
const MEMORY_CAP = 2400;

/**
 * A body far past the cap, with a marker only the tail carries. The bulk is
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
  test('over-long hits arrive capped and flagged, none is dropped, and recall still returns them whole', async () => {
    const user = await provisionE2EUser('briefing-caps@zm.e2e');
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
      expect(new Set(written).size).toBe(facets.length);

      const pack = firstJson<BriefingPack>(
        await mcp.callTool('build_context', { topic, briefing: true })
      );
      for (const [index, id] of written.entries()) {
        const hit = pack.memories.find((row) => row.id === id);
        // Capping the bodies must not cost the pack a single id.
        expect(hit, `${id} should still be delivered`).toBeDefined();
        // Every row is flagged: a silently cut body would let a reader trust
        // an incomplete fact as complete.
        expect(hit?.truncated).toBe(true);
        expect(hit?.content).toHaveLength(MEMORY_CAP);
        // The cap trims text, it does not summarize: the head is verbatim.
        expect(hit?.content.startsWith(`${topic}: ${facets[index]}`)).toBe(
          true
        );
        expect(hit?.content).not.toContain('TAIL-MARKER-ONLY-IN-THE-FULL-TEXT');
      }

      // The rest is one id away — that is what makes the cap honest.
      const recalled = firstJson<{
        memories: Array<{ id: string; content: string }>;
      }>(await mcp.callTool('recall', { query: topic }));
      const full = recalled.memories.find((row) => row.id === written[0]);
      expect(full?.content).toContain('TAIL-MARKER-ONLY-IN-THE-FULL-TEXT');
    } finally {
      await mcp.close();
    }
  });
});
