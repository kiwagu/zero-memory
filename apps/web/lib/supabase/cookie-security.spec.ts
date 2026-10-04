import { describe, expect, it } from 'vitest';

import { secureCookies } from './cookie-security';

describe('secureCookies', () => {
  it('marks the cookie Secure only when the browser came over https', () => {
    expect(secureCookies(new Headers({ 'x-forwarded-proto': 'https' }))).toBe(
      true
    );
    // Several proxies in a row list every hop; the browser's is the first.
    expect(
      secureCookies(new Headers({ 'x-forwarded-proto': 'https, http' }))
    ).toBe(true);
    expect(secureCookies(new Headers({ 'x-forwarded-proto': 'http' }))).toBe(
      false
    );
    // No edge at all: a local stand over plain http keeps a working cookie.
    expect(secureCookies(new Headers())).toBe(false);
  });
});
