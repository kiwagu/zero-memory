import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  evictUserSessionsOverCap,
  maxSessionsPerUserFromEnv,
} from './session-cap.js';

const makeSessions = (
  entries: Array<[string, string, number]>
): Map<string, { ownerUserEntityId: string; lastSeenAt: number }> =>
  new Map(
    entries.map(([id, owner, lastSeenAt]) => [
      id,
      { ownerUserEntityId: owner, lastSeenAt },
    ])
  );

describe('evictUserSessionsOverCap', () => {
  it('evicts only the caller’s own oldest sessions, never another user’s', () => {
    const sessions = makeSessions([
      ['a1', 'usr_a', 100],
      ['b1', 'usr_b', 50],
      ['a2', 'usr_a', 200],
      ['a3', 'usr_a', 300],
    ]);
    const evicted = evictUserSessionsOverCap(sessions, 'usr_a', 2);
    expect(evicted.map(([id]) => id)).toEqual(['a1']);
    expect([...sessions.keys()].sort()).toEqual(['a2', 'a3', 'b1']);
  });

  it('does nothing at or under the cap', () => {
    const sessions = makeSessions([
      ['a1', 'usr_a', 100],
      ['a2', 'usr_a', 200],
    ]);
    expect(evictUserSessionsOverCap(sessions, 'usr_a', 2)).toEqual([]);
    expect(sessions.size).toBe(2);
  });
});

describe('maxSessionsPerUserFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 20 and takes a positive integer override', () => {
    vi.stubEnv('ZM_MAX_SESSIONS_PER_USER', '');
    expect(maxSessionsPerUserFromEnv()).toBe(20);
    vi.stubEnv('ZM_MAX_SESSIONS_PER_USER', '5');
    expect(maxSessionsPerUserFromEnv()).toBe(5);
    vi.stubEnv('ZM_MAX_SESSIONS_PER_USER', 'many');
    expect(maxSessionsPerUserFromEnv()).toBe(20);
  });
});
