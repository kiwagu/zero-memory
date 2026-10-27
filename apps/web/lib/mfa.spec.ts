import { describe, expect, it } from 'vitest';

import { assuranceGap, verifyPathFor } from './mfa';

describe('assuranceGap', () => {
  it('asks for the code only when a factor exists and was not presented', () => {
    expect(assuranceGap(undefined, 0)).toBe('none');
    expect(assuranceGap('aal1', 0)).toBe('none');
    expect(assuranceGap('aal1', 1)).toBe('verify');
    expect(assuranceGap(undefined, 1)).toBe('verify');
    expect(assuranceGap('aal2', 1)).toBe('none');
  });
});

describe('verifyPathFor', () => {
  it('carries the page to return to, and none for the dashboard root', () => {
    expect(verifyPathFor('/')).toBe('/mfa/verify');
    expect(verifyPathFor('/settings')).toBe('/mfa/verify?next=%2Fsettings');
    expect(verifyPathFor('/oauth/consent?authorization_id=oaa_x')).toBe(
      '/mfa/verify?next=%2Foauth%2Fconsent%3Fauthorization_id%3Doaa_x'
    );
  });

  it('never carries a path that would leave the dashboard', () => {
    expect(verifyPathFor('//evil.test/x')).toBe('/mfa/verify');
  });
});
