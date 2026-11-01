import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoModelKeyError } from '@workspace/llm';

import { SupabaseCredentialResolver } from './credential-resolver.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../supabase.client.js', () => ({
  createServiceRoleClient: () => ({ rpc }),
}));

const SUBJECT = 'usr_000000000000000a.0000000000';

describe('SupabaseCredentialResolver', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    rpc.mockReset();
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

  it('reports a missing key when the owner stored none and the platform has none', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    rpc.mockResolvedValue({ data: [], error: null });

    await expect(
      new SupabaseCredentialResolver().resolve(SUBJECT)
    ).rejects.toBeInstanceOf(NoModelKeyError);
  });
});
