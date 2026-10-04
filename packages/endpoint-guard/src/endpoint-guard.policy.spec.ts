import { describe, expect, it } from 'vitest';

import { resolveDenyPrivateEndpoints } from './endpoint-guard.policy.js';

describe('resolveDenyPrivateEndpoints', () => {
  it('denies private endpoints when nothing is configured', () => {
    expect(resolveDenyPrivateEndpoints({})).toBe(true);
  });

  it.each([
    ['garbage', true],
    ['', true],
    ['true', true],
    ['1', true],
    ['on', true],
    ['yes', true],
    ['0', false],
    ['false', false],
    ['off', false],
    ['no', false],
    [' FALSE ', false],
  ])('%s -> %s', (raw, expected) => {
    expect(
      resolveDenyPrivateEndpoints({ ZM_POLICY_DENY_PRIVATE_ENDPOINTS: raw })
    ).toBe(expected);
  });
});
