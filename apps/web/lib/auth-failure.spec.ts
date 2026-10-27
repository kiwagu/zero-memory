import { describe, expect, it } from 'vitest';

import { authFailureOf, isAuthFailure } from './auth-failure';

describe('authFailureOf', () => {
  it('names the reason from the codes and never from the description', () => {
    expect(
      authFailureOf({ error: 'access_denied', errorCode: 'provider_denied' })
    ).toBe('provider_denied');
    expect(authFailureOf({ error: 'access_denied' })).toBe('provider_denied');
    expect(
      authFailureOf({ error: 'access_denied', errorCode: 'otp_expired' })
    ).toBe('link_expired');
    // The login page's own tokens round-trip.
    expect(authFailureOf({ error: 'missing_code' })).toBe('missing_code');
    expect(authFailureOf({ error: 'exchange_failed' })).toBe('exchange_failed');
    // Anything else, including text meant to be read, is unknown.
    expect(authFailureOf({ error: 'Call this number now' })).toBe('unknown');
    expect(authFailureOf({})).toBe('unknown');
  });

  it('recognises only its own tokens', () => {
    expect(isAuthFailure('link_expired')).toBe(true);
    expect(isAuthFailure('The user denied access')).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
  });
});
