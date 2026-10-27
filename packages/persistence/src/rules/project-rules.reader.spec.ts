import type { IContext } from '@workspace/context';
import { Scope } from '@workspace/memory';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createUserClient } from '../supabase.client.js';
import { SupabaseProjectRulesReader } from './project-rules.reader.js';
import {
  fakeRuleCandidateClient,
  type RuleCandidateRow,
} from './rule-candidate.client.fake.js';

vi.mock('../supabase.client.js', () => ({ createUserClient: vi.fn() }));

const PROJECT = 'proj.owner.acme';
const now = new Date().toISOString();

const projectRule = (row: RuleCandidateRow): RuleCandidateRow => ({
  pinned: false,
  promoted_at: now,
  applies_scope: null,
  memories: { scope: PROJECT },
  status: 'promoted',
  target_layer: 'project',
  revoked_at: null,
  ...row,
});

const context = { getAccessToken: () => 'access-token' } as IContext;

beforeEach(() => {
  vi.mocked(createUserClient).mockReset();
});

describe('SupabaseProjectRulesReader.listForScopes', () => {
  it('delivers each rule with its id and headline, and applies_when only when stored', async () => {
    vi.mocked(createUserClient).mockReturnValue(
      fakeRuleCandidateClient([
        projectRule({
          id: 'rlc_0123456789abcdfa.0123456789',
          rule_text: 'KEEP MIGRATIONS FORWARD-ONLY. Never edit an applied one.',
          pinned: true,
          applies_when: 'tasks that change the schema',
        }),
        projectRule({
          id: 'rlc_0123456789abcdfb.0123456789',
          rule_text: 'RUN THE E2E SUITE ON THE TEST STACK ONLY.',
          applies_when: null,
        }),
      ]).client
    );
    const reader = new SupabaseProjectRulesReader(context);
    const scope = Scope.create(PROJECT).unwrap();
    expect(await reader.listForScopes([scope])).toStrictEqual([
      {
        id: 'rlc_0123456789abcdfa.0123456789',
        text: 'KEEP MIGRATIONS FORWARD-ONLY. Never edit an applied one.',
        pinned: true,
        applies_when: 'tasks that change the schema',
      },
      {
        id: 'rlc_0123456789abcdfb.0123456789',
        text: 'RUN THE E2E SUITE ON THE TEST STACK ONLY.',
        pinned: false,
      },
    ]);
  });
});
