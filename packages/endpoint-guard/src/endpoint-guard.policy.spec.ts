import { describe, expect, it } from 'vitest';

import { resolveDenyPrivateEndpoints } from './endpoint-guard.policy.js';

describe('resolveDenyPrivateEndpoints', () => {
  it('defaults to false (self-host: permissive) when unset', () => {
    expect(resolveDenyPrivateEndpoints({})).toBe(false);
  });

  it.each([
    ['garbage', false],
    ['', false],
    ['0', false],
    ['false', false],
    ['true', true],
    ['1', true],
    ['on', true],
    ['yes', true],
    [' TRUE ', true],
  ])('%s -> %s', (raw, expected) => {
    expect(
      resolveDenyPrivateEndpoints({ ZM_POLICY_DENY_PRIVATE_ENDPOINTS: raw })
    ).toBe(expected);
  });
});
