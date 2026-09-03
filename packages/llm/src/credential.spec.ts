import { describe, expect, it } from 'vitest';

import { EnvCredentialResolver } from './credential.js';
import { effectiveModel } from './provider.js';

describe('EnvCredentialResolver', () => {
  it('resolves the platform key with no model of its own', async () => {
    const resolver = new EnvCredentialResolver({
      ANTHROPIC_API_KEY: 'platform-key',
      // Regression anchor: this env belongs to the extraction call sites,
      // not to the credential. Pinned here it would override the model of
      // EVERY platform-key call — judges and web search included.
      ZM_EXTRACTOR_MODEL: 'claude-haiku-4-5-20251001',
    } as NodeJS.ProcessEnv);

    const credential = await resolver.resolve();

    expect(credential).toEqual({
      provider: 'anthropic',
      apiKey: 'platform-key',
      ownedByCaller: false,
    });
    // Every call therefore keeps the model it names.
    expect(
      effectiveModel({ model: 'claude-sonnet-5' }, credential, 'a-default')
    ).toBe('claude-sonnet-5');
  });

  it('throws without the platform key', () => {
    // resolve() raises synchronously before constructing its promise.
    expect(() =>
      new EnvCredentialResolver({} as NodeJS.ProcessEnv).resolve()
    ).toThrow(/ANTHROPIC_API_KEY/);
  });
});
