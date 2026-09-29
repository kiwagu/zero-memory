import { afterEach, describe, expect, it, vi } from 'vitest';

import { evictSessionsOverCap, maxSessionsFromEnv } from './session-cap.js';

const makeSessions = (
  entries: Array<[string, number]>
): Map<string, { lastSeenAt: number }> =>
  new Map(entries.map(([id, lastSeenAt]) => [id, { lastSeenAt }]));

describe('evictSessionsOverCap', () => {
  it('does nothing at or under the cap', () => {
    const sessions = makeSessions([
      ['a', 1],
      ['b', 2],
    ]);
    expect(evictSessionsOverCap(sessions, 2)).toEqual([]);
    expect(sessions.size).toBe(2);
  });

  it('evicts the least-recently-used session first', () => {
    const sessions = makeSessions([
      ['newer', 300],
      ['oldest', 100],
      ['middle', 200],
    ]);
    const evicted = evictSessionsOverCap(sessions, 2);
    expect(evicted.map(([id]) => id)).toEqual(['oldest']);
    expect([...sessions.keys()]).toEqual(['newer', 'middle']);
  });

  it('evicts repeatedly until the map fits the cap, returning each session to close', () => {
    const sessions = makeSessions([
      ['a', 4],
      ['b', 1],
      ['c', 3],
      ['d', 2],
    ]);
    // The whole entry comes back, not just its id: the caller closes the
    // evicted session's transport.
    expect(evictSessionsOverCap(sessions, 1)).toEqual([
      ['b', { lastSeenAt: 1 }],
      ['d', { lastSeenAt: 2 }],
      ['c', { lastSeenAt: 3 }],
    ]);
    expect([...sessions.keys()]).toEqual(['a']);
  });
});

describe('maxSessionsFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 200', () => {
    vi.stubEnv('ZM_MAX_SESSIONS', '');
    expect(maxSessionsFromEnv()).toBe(200);
  });

  it('honors ZM_MAX_SESSIONS', () => {
    vi.stubEnv('ZM_MAX_SESSIONS', '5');
    expect(maxSessionsFromEnv()).toBe(5);
  });

  it('falls back to the default on non-positive or garbage values', () => {
    vi.stubEnv('ZM_MAX_SESSIONS', '-1');
    expect(maxSessionsFromEnv()).toBe(200);
    vi.stubEnv('ZM_MAX_SESSIONS', 'many');
    expect(maxSessionsFromEnv()).toBe(200);
  });
});
