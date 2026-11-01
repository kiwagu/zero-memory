import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoModelKeyError } from '@workspace/llm';

import { SupabaseCredentialResolver } from './credential-resolver.js';

const { rpc, storedRow } = vi.hoisted(() => ({
  rpc: vi.fn(),
  storedRow: vi.fn(),
}));
vi.mock('../supabase.client.js', () => ({
  createServiceRoleClient: () => ({
    rpc,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: storedRow }) }),
    }),
  }),
}));

const SUBJECT = 'usr_000000000000000a.0000000000';

describe('SupabaseCredentialResolver', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    rpc.mockReset();
    storedRow.mockReset();
  });

  it('falls back to the platform key when the stored credential cannot be read', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'platform-key');
    rpc.mockResolvedValue({ data: null, error: { message: 'pool exhausted' } });

    await expect(
      new SupabaseCredentialResolver().resolve(SUBJECT)
    ).resolves.toMatchObject({ apiKey: 'platform-key', ownedByCaller: false });
  });

  it('reports the failed lookup, not a missing key, when the platform has no key either', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    rpc.mockResolvedValue({ data: null, error: { message: 'pool exhausted' } });

    const failure = await new SupabaseCredentialResolver()
      .resolve(SUBJECT)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(NoModelKeyError);
    expect((failure as Error).message).toMatch(/pool exhausted/);
  });

  it.each([
    // The lookup joins the vault, so a key whose secret is gone comes back as no row.
    ['a key whose secret is gone', []],
    [
      'a key for a vendor this server has no adapter for',
      [
        {
          provider: 'retired-vendor',
          api_key: 'k',
          model: null,
          base_url: null,
        },
      ],
    ],
  ])(
    'reports %s as unusable, not missing, when the platform has no key',
    async (_, rows) => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      rpc.mockResolvedValue({ data: rows, error: null });
      storedRow.mockResolvedValue({
        data: { subject_id: SUBJECT },
        error: null,
      });

      const failure = await new SupabaseCredentialResolver()
        .resolve(SUBJECT)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(NoModelKeyError);
      expect((failure as Error).message).toMatch(/cannot be used/);
    }
  );

  it('reports a missing key when the owner stored none and the platform has none', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    rpc.mockResolvedValue({ data: [], error: null });
    storedRow.mockResolvedValue({ data: null, error: null });

    await expect(
      new SupabaseCredentialResolver().resolve(SUBJECT)
    ).rejects.toBeInstanceOf(NoModelKeyError);
  });
});
