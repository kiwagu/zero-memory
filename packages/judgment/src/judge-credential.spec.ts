import { describe, expect, it } from 'vitest';

import { EnvJudgeCredentialResolver } from './judge-credential.js';
import { readJudgeConfig } from './judge-config.js';

describe('EnvJudgeCredentialResolver', () => {
  it('returns the platform key of the default provider, not owned by the caller', async () => {
    const resolver = new EnvJudgeCredentialResolver(
      readJudgeConfig({ ZM_TYPESAFE_API_KEY: 'ts', SNAPQ_API_KEY: 'sq' })
    );
    await expect(resolver.resolve('usr_a')).resolves.toEqual({
      provider: 'typesafe',
      apiKey: 'ts',
      model: 'jev-1.14.0',
      ownedByCaller: false,
    });
  });

  it('honours a preferred provider when it has a platform key', async () => {
    const resolver = new EnvJudgeCredentialResolver(
      readJudgeConfig({ ZM_TYPESAFE_API_KEY: 'ts', SNAPQ_API_KEY: 'sq' })
    );
    await expect(resolver.resolve('usr_a', 'subq')).resolves.toMatchObject({
      provider: 'subq',
      apiKey: 'sq',
      model: 'snap-1.1',
    });
  });

  it('is null when the wanted provider has no platform key — never another provider', async () => {
    const resolver = new EnvJudgeCredentialResolver(
      readJudgeConfig({ ZM_TYPESAFE_API_KEY: 'ts' })
    );
    await expect(resolver.resolve('usr_a', 'subq')).resolves.toBeNull();
    await expect(
      new EnvJudgeCredentialResolver(readJudgeConfig({})).resolve('usr_a')
    ).resolves.toBeNull();
  });
});
