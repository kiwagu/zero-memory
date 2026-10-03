import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { SupabaseAuthGateway } from './supabase-auth-gateway.js';

const ALICE = 'a0000000-0000-4000-8000-00000000000a';
const BOB = 'b0000000-0000-4000-8000-00000000000b';

const sessionOf = (userId: string) => ({
  access_token: `access-${userId}`,
  refresh_token: `refresh-${userId}`,
  expires_in: 3600,
  user: { id: userId, email: 'alice@example.com' },
});

/**
 * Just the Auth calls `mintSession` makes, answering as configured: the link
 * is issued for `linkUser` and redeems into a session of `sessionUser`.
 */
const fakeAuth = ({
  linkUser = ALICE,
  sessionUser = ALICE,
}: { linkUser?: string; sessionUser?: string } = {}) => {
  const signOut = vi.fn().mockResolvedValue({ error: null });
  const service = {
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue({
          data: { user: { id: ALICE, email: 'alice@example.com' } },
          error: null,
        }),
        generateLink: vi.fn().mockResolvedValue({
          data: {
            user: { id: linkUser },
            properties: { hashed_token: 'hashed' },
          },
          error: null,
        }),
        signOut,
      },
    },
  } as unknown as SupabaseClient;
  const verifyOtp = vi.fn().mockResolvedValue({
    data: { session: sessionOf(sessionUser) },
    error: null,
  });
  const anon = { auth: { verifyOtp } } as unknown as SupabaseClient;
  const gateway = new SupabaseAuthGateway({
    anon: () => anon,
    service: () => service,
  });
  return { gateway, signOut, verifyOtp };
};

describe('SupabaseAuthGateway.mintSession', () => {
  it('returns a fresh session of the user it was asked for', async () => {
    const { gateway, signOut } = fakeAuth();
    const minted = await gateway.mintSession(ALICE);
    expect(minted).toMatchObject({
      userId: ALICE,
      accessToken: `access-${ALICE}`,
    });
    expect(signOut).not.toHaveBeenCalled();
  });

  it('does not redeem a link issued for another user', async () => {
    // The email moved to another account between the lookup and the link.
    const { gateway, verifyOtp } = fakeAuth({ linkUser: BOB });
    expect(await gateway.mintSession(ALICE)).toBeNull();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('revokes and withholds a session that belongs to another user', async () => {
    const { gateway, signOut } = fakeAuth({ sessionUser: BOB });
    expect(await gateway.mintSession(ALICE)).toBeNull();
    expect(signOut).toHaveBeenCalledExactlyOnceWith(`access-${BOB}`, 'local');
  });

  it('still withholds the session when revoking it fails', async () => {
    const { gateway, signOut } = fakeAuth({ sessionUser: BOB });
    signOut.mockRejectedValueOnce(new Error('network down'));
    expect(await gateway.mintSession(ALICE)).toBeNull();
  });
});
