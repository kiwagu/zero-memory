import { JudgeCredentialUnavailableError } from '@workspace/judgment';
import { describe, expect, it, vi } from 'vitest';

import { SupabaseJudgeCredentialResolver } from './judge-credential-resolver.js';

const rpcReturning = (data: unknown) => ({
  rpc: vi.fn().mockResolvedValue({ data, error: null }),
});

describe('SupabaseJudgeCredentialResolver', () => {
  const platform = {
    resolve: vi.fn(
      async (_s: string | null, preferred?: 'typesafe' | 'subq') =>
        preferred === 'subq'
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

  it('throws when the lookup fails instead of falling back to the platform key, and logs no key', async () => {
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
    const warned = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    platform.resolve.mockClear();
    try {
      await expect(resolver.resolve('usr_a')).rejects.toBeInstanceOf(
        JudgeCredentialUnavailableError
      );
      expect(platform.resolve).not.toHaveBeenCalled();
      expect(String(warned.mock.calls[0]?.[0])).toContain('boom');
    } finally {
      warned.mockRestore();
    }
  });

  it('throws on a row that is not a credential, and never shows the row', async () => {
    const client = rpcReturning([
      { provider: 'elsewhere', model: null, api_key: 'own-key-value' },
    ]);
    const resolver = new SupabaseJudgeCredentialResolver(
      platform,
      () => client as never,
      {
        typesafe: 'jev-1.14.0',
        subq: 'subq-snap-1.1',
      }
    );
    const warned = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    platform.resolve.mockClear();
    try {
      const error = await resolver.resolve('usr_a').then(
        () => null,
        (rejection: unknown) => rejection
      );
      expect(error).toBeInstanceOf(JudgeCredentialUnavailableError);
      expect(String((error as Error).message)).not.toContain('own-key-value');
      expect(platform.resolve).not.toHaveBeenCalled();
      expect(warned.mock.calls.join('\n')).not.toContain('own-key-value');
    } finally {
      warned.mockRestore();
    }
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
      expect(platform.resolve).toHaveBeenCalledWith('usr_a', undefined);
    }
  );
});
