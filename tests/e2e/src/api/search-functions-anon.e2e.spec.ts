/**
 * The search and history functions are for signed-in callers: an anonymous
 * request through the database API is refused before the function runs, and
 * a signed-in user still gets an answer.
 */
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken, userRestClient } from '../helpers/users.js';

const anon = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const CALLS = [
  {
    name: 'search_memories',
    args: {
      query_embedding: '[0.1,0.2,0.3]',
      query_text: 'deploys',
      scope_filter: ['user'],
      k: 1,
      kinds: null,
    },
  },
  {
    name: 'find_similar_memory',
    args: { query_embedding: '[0.1,0.2,0.3]', scope_filter: 'user' },
  },
  {
    name: 'memory_version_history',
    args: { p_id: 'mem_0000000000000000.0000000000' },
  },
] as const;

test.describe('search and history functions refuse anonymous callers', () => {
  for (const call of CALLS) {
    test(`@smoke ${call.name} is not executable without a session`, async () => {
      const { error } = await anon().rpc(call.name, call.args);
      expect(error?.code).toBe('42501');
    });
  }

  test('@smoke a signed-in user can still read version history', async () => {
    const seed = await readSeedState();
    const { error } = await userRestClient(
      await passwordGrantToken(seed.userA)
    ).rpc('memory_version_history', {
      p_id: 'mem_0000000000000000.0000000000',
    });
    expect(error).toBeNull();
  });
});
