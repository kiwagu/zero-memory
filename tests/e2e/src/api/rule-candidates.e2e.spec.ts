/**
 * Rules-incubator detection rollup (`find_rule_candidates`): the SQL that
 * decides candidacy. Asserted at the integration layer through the service
 * role — the thresholds are the product contract: a fact re-asked usefully
 * in >= 3 distinct sessions has earned always-on delivery.
 */
import { expect, test } from '@playwright/test';

import {
  findRuleCandidatesRollup,
  seedRecallUsedSignal,
  seedRuleCandidate,
} from '../helpers/rules.js';
import { readSeedState } from '../helpers/runtime-state.js';

test.describe('find_rule_candidates rollup', () => {
  test('@smoke a memory useful in 3 distinct sessions qualifies; 2 does not', async () => {
    const seed = await readSeedState();
    const qualifying = await seedRecallUsedSignal(
      seed.userA,
      'E2E incubator signal: migrations always get a header comment block.',
      3
    );
    const below = await seedRecallUsedSignal(
      seed.userA,
      'E2E incubator signal: prefer bun over npm in this monorepo.',
      2
    );

    const rollup = await findRuleCandidatesRollup(seed.userA);
    const byMemory = new Map(rollup.map((row) => [row.memory_id, row]));

    expect(byMemory.get(qualifying)?.useful_sessions).toBe(3);
    expect(byMemory.has(below)).toBe(false);
  });

  test('an existing candidacy excludes the memory from the rollup forever', async () => {
    const seed = await readSeedState();
    // The seeded candidate's memory also gets a qualifying signal…
    const candidate = await seedRuleCandidate(seed.userA);
    const client = await seedRecallUsedSignal(
      seed.userA,
      // Same content as the seeded candidate's memory → same memory id.
      'E2E incubator fixture: commit messages are single-line `type(scope): subject`.',
      3
    );
    expect(client).toBe(candidate.memoryId);

    // …but the rule_candidates row (whatever its status) blocks re-proposal.
    const rollup = await findRuleCandidatesRollup(seed.userA);
    expect(rollup.some((row) => row.memory_id === candidate.memoryId)).toBe(
      false
    );
  });
});
