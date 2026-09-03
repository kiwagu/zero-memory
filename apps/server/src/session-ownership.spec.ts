import { describe, expect, it } from 'vitest';

import { sessionForOwner } from './session-ownership.js';

describe('sessionForOwner', () => {
  it('returns the session when the caller is its creator', () => {
    const sessions = new Map([['sess_a', { ownerUserEntityId: 'usr_alice' }]]);
    expect(sessionForOwner(sessions, 'sess_a', 'usr_alice')).toEqual({
      ownerUserEntityId: 'usr_alice',
    });
  });

  it('refuses a session id created by a different user', () => {
    const sessions = new Map([['sess_a', { ownerUserEntityId: 'usr_alice' }]]);
    expect(sessionForOwner(sessions, 'sess_a', 'usr_bob')).toBeUndefined();
  });

  it('is indistinguishable from a genuinely missing session id', () => {
    const sessions = new Map([['sess_a', { ownerUserEntityId: 'usr_alice' }]]);
    const foreignLookup = sessionForOwner(sessions, 'sess_a', 'usr_bob');
    const missingLookup = sessionForOwner(sessions, 'sess_missing', 'usr_bob');
    expect(foreignLookup).toBe(missingLookup);
    expect(foreignLookup).toBeUndefined();
  });
});
