import { afterEach, describe, expect, it } from 'vitest';

import { buildVersion } from './build-version';

const cleanup: string[] = ['ZM_BUILD_VERSION', 'ZM_BUILD_COMMIT'];
afterEach(() => {
  for (const key of cleanup) delete process.env[key];
});

describe('buildVersion', () => {
  it('renders the baked tag and the first 8 commit characters', () => {
    process.env.ZM_BUILD_VERSION = 'v0.2.0';
    process.env.ZM_BUILD_COMMIT = '1234567890abcdef';
    expect(buildVersion()).toBe('v0.2.0+12345678');
  });

  it('prefixes a bare semver with v', () => {
    process.env.ZM_BUILD_VERSION = '0.2.0';
    process.env.ZM_BUILD_COMMIT = 'abcdef1234';
    expect(buildVersion()).toBe('v0.2.0+abcdef12');
  });

  it('falls back to the package version and dev outside an image build', () => {
    expect(buildVersion()).toMatch(/^v\d+\.\d+\.\d+\+dev$/);
  });
});
