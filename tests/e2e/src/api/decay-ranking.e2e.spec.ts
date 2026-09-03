/**
 * Kind-based ranking decay end-to-end: an old episode ranks far below an
 * equivalent fresh one, while protected kinds (gotcha here) barely move with
 * age — and decay is demotion only, so every aged memory is still found by a
 * direct recall. Fixtures are written through the normal `remember` path and
 * then backdated (created_at is the only input of the decay multiplier).
 */
import { expect, test } from '@playwright/test';

import { backdateMemory } from '../helpers/decay.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

interface RecallHit {
  id: string;
  kind: string;
  score: number;
}

/** One distinctive token all four fixtures share — the recall query. */
const MARKER = 'zubrowkabeacon';
const AGE_DAYS = 180;

const remember = async (
  mcp: McpTestClient,
  kind: string,
  content: string
): Promise<string> => {
  const result = await mcp.callTool('remember', {
    content,
    kind,
    scope: 'personal',
  });
  expect(result.isError ?? false).toBe(false);
  return firstJson<{ memory_id: string }>(result).memory_id;
};

test.describe('ranking decay by kind', () => {
  test('an aged episode sinks, an aged gotcha holds, both stay recallable', async () => {
    const seed = await readSeedState();
    // User B on purpose: these four memories would otherwise leak into user
    // A's other specs (surfaced counts, top-facts ordering) under parallel
    // workers. Wording deliberately shares no terms with other specs' queries.
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // Four fixtures sharing the marker: an episode pair and a gotcha pair,
      // one of each aged well past the episode half-life (30 d) but well
      // inside the gotcha half-life (1095 d). Contents diverge beyond the
      // marker so the write-time near-duplicate probe never merges them.
      const freshEpisode = await remember(
        mcp,
        'episode',
        `Decay probe: session log — investigated the ${MARKER} flake ` +
          'today, root cause still unknown.'
      );
      const agedEpisode = await remember(
        mcp,
        'episode',
        `Decay probe: archived session note — first sighting of the ` +
          `${MARKER} flake during the original bring-up.`
      );
      const freshGotcha = await remember(
        mcp,
        'gotcha',
        `Decay probe: gotcha — the ${MARKER} flag must be quoted in ` +
          'zsh, otherwise the glob expansion eats it.'
      );
      const agedGotcha = await remember(
        mcp,
        'gotcha',
        `Decay probe: gotcha from the archive — the ${MARKER} daemon ` +
          'ignores SIGHUP unless it was started with --foreground.'
      );
      await backdateMemory(agedEpisode, AGE_DAYS);
      await backdateMemory(agedGotcha, AGE_DAYS);

      const recalled = await mcp.callTool('recall', {
        query: MARKER,
        k: 10,
      });
      expect(recalled.isError ?? false).toBe(false);
      const hits = firstJson<{ memories: RecallHit[] }>(recalled).memories;
      const byId = new Map(hits.map((hit) => [hit.id, hit]));

      // Demotion, not disappearance: a direct query still finds every fixture.
      for (const id of [freshEpisode, agedEpisode, freshGotcha, agedGotcha]) {
        expect(byId.get(id), `${id} must stay recallable`).toBeTruthy();
      }

      const score = (id: string): number => byId.get(id)!.score;

      // The aged episode sank: 180 d on a 30 d half-life ≈ ×0.016 — far below
      // its fresh twin even with hybrid-rank noise (bounds are deliberately
      // loose: RRF rank spread can move scores a few ×, never ~60×).
      expect(score(freshEpisode)).toBeGreaterThan(score(agedEpisode));
      expect(score(agedEpisode) / score(freshEpisode)).toBeLessThan(0.1);

      // The protected kind held: 180 d on a 1095 d half-life ≈ ×0.89.
      expect(score(agedGotcha) / score(freshGotcha)).toBeGreaterThan(0.25);

      // Same age, different kind: the durable gotcha outranks the episode.
      expect(score(agedGotcha)).toBeGreaterThan(score(agedEpisode));
    } finally {
      await mcp.close();
    }
  });
});
