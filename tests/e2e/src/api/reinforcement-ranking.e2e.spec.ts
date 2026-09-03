/**
 * Usage-reinforcement wiring end-to-end: a precomputed multiplier row moves a
 * memory in the recall ranking — a boosted fact overtakes its unboosted twin,
 * a demoted (promoted-to-rules) fact sinks — and an absent row stays exactly
 * neutral. Runs as user B so the writes never disturb user A's parity specs.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { setReinforcementMultiplier } from '../helpers/reinforcement.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

interface RecallHit {
  id: string;
  score: number;
}

const MARKER = 'kalimbatrellis';

const remember = async (
  mcp: McpTestClient,
  content: string
): Promise<string> => {
  const result = await mcp.callTool('remember', {
    content,
    kind: 'fact',
    scope: 'personal',
  });
  expect(result.isError ?? false).toBe(false);
  return firstJson<{ memory_id: string }>(result).memory_id;
};

const recallScores = async (
  mcp: McpTestClient
): Promise<Map<string, number>> => {
  const result = await mcp.callTool('recall', { query: MARKER, k: 10 });
  expect(result.isError ?? false).toBe(false);
  return new Map(
    firstJson<{ memories: RecallHit[] }>(result).memories.map((hit) => [
      hit.id,
      hit.score,
    ])
  );
};

test.describe('usage-reinforcement ranking', () => {
  test('a multiplier row boosts, demotes, and an absent row is neutral', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const boosted = await remember(
        mcp,
        `Reinforcement probe: the ${MARKER} exporter writes checksums into ` +
          'the manifest before upload.'
      );
      const neutral = await remember(
        mcp,
        `Reinforcement probe: the ${MARKER} importer validates manifests ` +
          'against stored checksums on arrival.'
      );
      const demoted = await remember(
        mcp,
        `Reinforcement probe: the ${MARKER} scheduler retries a failed ` +
          'manifest transfer three times before alerting.'
      );

      // Baseline: no reinforcement rows — all three rank by relevance alone.
      const before = await recallScores(mcp);
      for (const id of [boosted, neutral, demoted]) {
        expect(before.get(id), `${id} must be recallable`).toBeTruthy();
      }

      await setReinforcementMultiplier(boosted, 1.4);
      await setReinforcementMultiplier(demoted, 0.6);

      const after = await recallScores(mcp);

      // The neutral memory's score is untouched (absent row = exact 1.0;
      // precision 7 leaves room for the seconds of decay drift between the
      // two recalls), while the boosted one rose and the demoted one sank by
      // their factors.
      expect(after.get(neutral)).toBeCloseTo(before.get(neutral)!, 7);
      expect(after.get(boosted)! / before.get(boosted)!).toBeCloseTo(1.4, 5);
      expect(after.get(demoted)! / before.get(demoted)!).toBeCloseTo(0.6, 5);

      // And the order now reflects usefulness: boosted above neutral above
      // demoted, whatever the relevance tie-breaks said before.
      expect(after.get(boosted)!).toBeGreaterThan(after.get(neutral)!);
      expect(after.get(neutral)!).toBeGreaterThan(after.get(demoted)!);
    } finally {
      await mcp.close();
    }
  });
});
