import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createUserClient } from '../supabase.client.js';
import {
  listPromotedUserRules,
  readPromotedRuleById,
} from './promoted-rules.reader.js';
import {
  fakeRuleCandidateClient,
  type RuleCandidateRow,
} from './rule-candidate.client.fake.js';

vi.mock('../supabase.client.js', () => ({ createUserClient: vi.fn() }));

const TOKEN = 'access-token';
const now = new Date().toISOString();

/** A pinned General rule with a stored condition of application. */
const RULE_A: RuleCandidateRow = {
  id: 'rlc_0123456789abcdfa.0123456789',
  rule_text: '  ALWAYS RUN THE GATES BEFORE COMMITTING. A red hook…  ',
  pinned: true,
  promoted_at: now,
  applies_when: 'tasks that commit',
  status: 'promoted',
  target_layer: 'user',
  revoked_at: null,
};

/** An unpinned General rule with no condition stored. */
const RULE_B: RuleCandidateRow = {
  id: 'rlc_0123456789abcdfb.0123456789',
  rule_text: 'NEVER PUSH TO MAIN DIRECTLY.',
  pinned: false,
  promoted_at: now,
  applies_when: null,
  status: 'promoted',
  target_layer: 'user',
  revoked_at: null,
};

/** A project-layer rule: the one-rule read serves both layers. */
const RULE_P: RuleCandidateRow = {
  ...RULE_B,
  id: 'rlc_0123456789abcdfc.0123456789',
  rule_text: 'KEEP MIGRATIONS FORWARD-ONLY. Never edit an applied one.',
  target_layer: 'project',
};

/** The owner revoked it on /rules: it stays promoted but is not live. */
const REVOKED: RuleCandidateRow = {
  ...RULE_B,
  id: 'rlc_0123456789abcdfd.0123456789',
  revoked_at: now,
};

const serve = (rows: RuleCandidateRow[]) => {
  const fake = fakeRuleCandidateClient(rows);
  vi.mocked(createUserClient).mockReturnValue(fake.client);
  return fake;
};

beforeEach(() => {
  vi.mocked(createUserClient).mockReset();
});

describe('listPromotedUserRules', () => {
  it('delivers each rule with its id and headline, and applies_when only when stored', async () => {
    serve([RULE_A, RULE_B]);
    expect(await listPromotedUserRules(TOKEN)).toStrictEqual([
      {
        id: RULE_A.id,
        text: 'ALWAYS RUN THE GATES BEFORE COMMITTING. A red hook…',
        pinned: true,
        headline: 'ALWAYS RUN THE GATES BEFORE COMMITTING',
        applies_when: 'tasks that commit',
      },
      {
        id: RULE_B.id,
        text: 'NEVER PUSH TO MAIN DIRECTLY.',
        pinned: false,
        headline: 'NEVER PUSH TO MAIN DIRECTLY',
      },
    ]);
  });
});

describe('readPromotedRuleById', () => {
  it('reads one live rule in full, from either layer', async () => {
    serve([RULE_A, RULE_B, RULE_P]);
    expect(await readPromotedRuleById(TOKEN, RULE_A.id)).toStrictEqual({
      id: RULE_A.id,
      text: 'ALWAYS RUN THE GATES BEFORE COMMITTING. A red hook…',
      pinned: true,
      headline: 'ALWAYS RUN THE GATES BEFORE COMMITTING',
      level: 'full',
      applies_when: 'tasks that commit',
    });
    expect(await readPromotedRuleById(TOKEN, RULE_P.id)).toStrictEqual({
      id: RULE_P.id,
      text: 'KEEP MIGRATIONS FORWARD-ONLY. Never edit an applied one.',
      pinned: false,
      headline: 'KEEP MIGRATIONS FORWARD-ONLY',
      level: 'full',
    });
  });

  it('answers null for a missing or revoked rule, and asks nothing for a non-rule id', async () => {
    const fake = serve([RULE_B, REVOKED]);
    expect(
      await readPromotedRuleById(TOKEN, 'rlc_0123456789abcdfz.0123456789')
    ).toBeNull();
    expect(await readPromotedRuleById(TOKEN, REVOKED.id)).toBeNull();
    expect(fake.from).toHaveBeenCalledTimes(2);

    fake.from.mockClear();
    expect(await readPromotedRuleById(TOKEN, 'not-a-rule-id')).toBeNull();
    expect(fake.from).not.toHaveBeenCalled();
  });
});
