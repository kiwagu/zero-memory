/**
 * Below the focused hits, the pack shows the passage that MATCHED.
 *
 * A long memory used to be inlined from its start, so a hit that earned its
 * place through something written late arrived as an unrelated first
 * paragraph. The fixture here is built so that only the ENDING is about the
 * query: five short decoys take the focused ranks, and the long record lands
 * below them, where its delivery becomes an excerpt.
 *
 * What the pack guarantees is the matched REGION, not the matched sentence:
 * the excerpt is cut from the start of the window that scored, and that window
 * is wider than the excerpt. So this asserts the excerpt is a real span of the
 * record taken from somewhere other than its opening, and that it says so — a
 * middle span silently presented as an opening would be a worse failure than
 * the truncation this replaces.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

interface Pack {
  memories: Array<{ id: string; content: string; truncated: boolean }>;
}

/** Default zm.memory_focus_count — hits from here down are excerpted. */
const FOCUS_COUNT = 3;

const TAIL_MARKER = 'the kiln firing schedule for stoneware glazes';

/**
 * Opening long enough to fill the model's window several times over and about
 * something else entirely. The ending is the only part on topic, and it is
 * phrased so that no query word appears in it — the text leg cannot reach it,
 * so only its embedding window can.
 */
const OPENING_MARKER = 'Notes on the workshop inventory process';

const LONG_MEMORY =
  `${OPENING_MARKER}, which is what this record opens with and what a ` +
  'head-truncated delivery would show. ' +
  (
    'Stock counts are recorded on the sheet by the door, the signature ' +
    'column is filled at the end of each shift, spare parts live in the ' +
    'grey cabinet, and a consumable that runs out is reordered the same ' +
    'week from the usual supplier. '
  ).repeat(9) +
  'The part that actually answers the question, and it never repeats the ' +
  'words a search would use: bisque runs go overnight at a low ramp, the ' +
  'glaze burn follows two days later, and the oven is never opened before it ' +
  'has fallen below sixty degrees.';

/**
 * Short notes that all answer the query and differ from EACH OTHER — near
 * copies would be collapsed by write-time dedup and only one would survive,
 * leaving the focused ranks free for the record this spec is about.
 */
const DECOYS = [
  `On ${TAIL_MARKER}: hold the top temperature for twenty minutes.`,
  `On ${TAIL_MARKER}: cone six is the target, checked against the witness.`,
  `On ${TAIL_MARKER}: vent the damper once the smoke stops.`,
  `On ${TAIL_MARKER}: load the shelves with a finger of clearance.`,
  `On ${TAIL_MARKER}: wax the foot rings before dipping.`,
  `On ${TAIL_MARKER}: log the ramp rate against the controller programme.`,
  `On ${TAIL_MARKER}: never stack unglazed and glazed work together.`,
  `On ${TAIL_MARKER}: the spare thermocouple lives in the second drawer.`,
];

test.describe('matched excerpt', () => {
  test('a hit below the focused ranks shows the passage that matched', async () => {
    const user = await provisionE2EUser(`zm-excerpt-${Date.now()}@zm.e2e`);
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const remember = async (content: string): Promise<string> => {
        const result = await mcp.callTool('remember', {
          content,
          kind: 'fact',
          scope: 'personal',
        });
        expect(result.isError ?? false).toBe(false);
        return firstJson<{ memory_id: string }>(result).memory_id;
      };

      const longId = await remember(LONG_MEMORY);
      // Enough decoys, each carrying the query verbatim, to own the focused
      // ranks — the long record is reachable only through its ending.
      for (const decoy of DECOYS) {
        await remember(decoy);
      }

      const briefing = await mcp.callTool('build_context', {
        topic: TAIL_MARKER,
      });
      expect(briefing.isError ?? false).toBe(false);
      const pack = firstJson<Pack>(briefing).memories;

      const index = pack.findIndex((hit) => hit.id === longId);
      expect(index, 'the long record must be in the pack').toBeGreaterThan(-1);
      expect(
        index,
        'the short decoys must take the focused ranks, or this spec proves ' +
          'nothing about excerpting'
      ).toBeGreaterThanOrEqual(FOCUS_COUNT);

      const delivered = pack[index]!.content;
      expect(pack[index]!.truncated).toBe(true);

      // It is marked as not starting at the beginning...
      expect(delivered.startsWith('…')).toBe(true);
      // ...and it does not start at the beginning: the record's own opening
      // is absent, which is the whole difference from head-truncation.
      expect(delivered).not.toContain(OPENING_MARKER);

      // What is guaranteed is the REGION, not the sentence: the excerpt is cut
      // from the matched window's start, and that window is wider than the
      // excerpt, so the exact phrase that scored may lie further inside it.
      const body = delivered.replace(/^…|…$/g, '');
      const offset = LONG_MEMORY.indexOf(body);
      expect(
        offset,
        'the excerpt must be a real span of the record'
      ).toBeGreaterThan(0);
    } finally {
      await mcp.close();
    }
  });
});
