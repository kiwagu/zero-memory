import { entityIdSchemas } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import { InProcessWorkClaims, workClaimKey } from './work-claims.js';

describe('InProcessWorkClaims', () => {
  it('lets one holder at a time take a key, and again once it is released', async () => {
    const claims = new InProcessWorkClaims();
    const key = workClaimKey('hygiene-scan', 'usr_1');

    const token = await claims.claim(key);
    expect(entityIdSchemas.work_claim.is(token)).toBe(true);
    expect(await claims.claim(key)).toBeNull();
    expect(
      await claims.claim(workClaimKey('benchmark', 'usr_1'))
    ).not.toBeNull();
    expect(
      await claims.claim(workClaimKey('hygiene-scan', 'usr_2'))
    ).not.toBeNull();

    await claims.release(key, token!);
    expect(await claims.claim(key)).not.toBeNull();
  });

  it('ignores a release by a holder whose claim is no longer the current one', async () => {
    const claims = new InProcessWorkClaims();
    const key = workClaimKey('benchmark', 'usr_1');
    const first = await claims.claim(key);
    await claims.release(key, first!);
    const second = await claims.claim(key);

    await claims.release(key, first!);

    expect(second).not.toBeNull();
    expect(await claims.claim(key)).toBeNull();
  });
});
