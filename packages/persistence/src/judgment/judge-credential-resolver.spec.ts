import type { JudgeProviderName } from '@workspace/judgment';
import { describe, expect, it, vi } from 'vitest';

import { SupabaseJudgeCredentialResolver } from './judge-credential-resolver.js';

const rpcReturning = (data: unknown) => ({
  rpc: vi.fn().mockResolvedValue({ data, error: null }),
});

describe('SupabaseJudgeCredentialResolver', () => {
  const platform = {
    resolve: vi.fn(
      async (
        _s: string | null,
        preferred?: JudgeProviderName | Promise<JudgeProviderName | undefined>
      ) =>
        (await preferred) === 'subq'
          ? {
              provider: 'subq' as const,
              apiKey: 'platform-sq',
              model: 'subq-snap-1.1',
              ownedByCaller: false,
            }
          : {
              provider: 'typesafe' as const,
              apiKey: 'platform-ts',
              model: 'jev-1.14.0',
              ownedByCaller: false,
            }
    ),
  };

  it("prefers the account's own key and marks it as theirs", async () => {
    const client = rpcReturning([
      { provider: 'subq', model: null, api_key: 'own-key' },
    ]);
    const resolver = new SupabaseJudgeCredentialResolver(
      platform,
      () => client as never,
      {
        typesafe: 'jev-1.14.0',
        subq: 'subq-snap-1.1',
      }
    );
    await expect(resolver.resolve('usr_a')).resolves.toEqual({
      provider: 'subq',
      apiKey: 'own-key',
      model: 'subq-snap-1.1',
      ownedByCaller: true,
    });
  });

  it('falls back to the platform key of the preferred provider when the account has none', async () => {
    const client = rpcReturning([]);
    const resolver = new SupabaseJudgeCredentialResolver(
      platform,
      () => client as never,
      {
        typesafe: 'jev-1.14.0',
        subq: 'subq-snap-1.1',
      }
    );
    await expect(resolver.resolve('usr_a', 'subq')).resolves.toMatchObject({
      provider: 'subq',
      apiKey: 'platform-sq',
    });
  });

  it('uses the platform key when the lookup fails, and logs no key', async () => {
    const client = {
      rpc: vi
        .fn()
        .mockResolvedValue({ data: null, error: { message: 'boom' } }),
    };
    const resolver = new SupabaseJudgeCredentialResolver(
      platform,
      () => client as never,
      {
        typesafe: 'jev-1.14.0',
        subq: 'subq-snap-1.1',
      }
    );
    await expect(resolver.resolve('usr_a')).resolves.toMatchObject({
      provider: 'typesafe',
      ownedByCaller: false,
    });
  });

  it.each(['gpt', 'constructor'])(
    'treats a preferred provider outside the closed set (%s) as no preference',
    async (preferred) => {
      const client = rpcReturning([]);
      const resolver = new SupabaseJudgeCredentialResolver(
        platform,
        () => client as never,
        {
          typesafe: 'jev-1.14.0',
          subq: 'subq-snap-1.1',
        }
      );
      platform.resolve.mockClear();
      await expect(
        resolver.resolve('usr_a', preferred as never)
      ).resolves.toMatchObject({ provider: 'typesafe', apiKey: 'platform-ts' });
      expect(await platform.resolve.mock.calls[0]![1]).toBeUndefined();
    }
  );

  it("looks up the account's own key without waiting for a preference still being read", async () => {
    const client = rpcReturning([
      { provider: 'typesafe', model: 'jev-2', api_key: 'own-key' },
    ]);
    const resolver = new SupabaseJudgeCredentialResolver(
      platform,
      () => client as never,
      {
        typesafe: 'jev-1.14.0',
        subq: 'subq-snap-1.1',
      }
    );
    const never = new Promise<JudgeProviderName | undefined>(() => undefined);
    await expect(resolver.resolve('usr_a', never)).resolves.toMatchObject({
      apiKey: 'own-key',
      ownedByCaller: true,
    });
  });

  it('waits for a preference still being read before falling back to a platform key', async () => {
    const client = rpcReturning([]);
    const resolver = new SupabaseJudgeCredentialResolver(
      platform,
      () => client as never,
      {
        typesafe: 'jev-1.14.0',
        subq: 'subq-snap-1.1',
      }
    );
    await expect(
      resolver.resolve('usr_a', Promise.resolve('subq'))
    ).resolves.toMatchObject({ provider: 'subq', apiKey: 'platform-sq' });
  });
});
