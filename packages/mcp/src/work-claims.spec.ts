import { describe, expect, it } from 'vitest';

import { InProcessWorkClaims, workClaimKey } from './work-claims.js';

describe('InProcessWorkClaims', () => {
  it('lets one holder at a time take a key, and again once it is released', async () => {
    const claims = new InProcessWorkClaims();
    const key = workClaimKey('hygiene-scan', 'usr_1');

    expect(await claims.claim(key)).toBe(true);
    expect(await claims.claim(key)).toBe(false);
    expect(await claims.claim(workClaimKey('benchmark', 'usr_1'))).toBe(true);
    expect(await claims.claim(workClaimKey('hygiene-scan', 'usr_2'))).toBe(
      true
    );

    await claims.release(key);
    expect(await claims.claim(key)).toBe(true);
  });
});
