import type { IContext } from '@workspace/context';
import { JUDGE_SETTINGS_OFF } from '@workspace/judgment';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createUserClient, type Client } from '../supabase.client.js';
import { SupabaseJudgeSettingsReader } from './judge-settings.reader.js';

vi.mock('../supabase.client.js', () => ({ createUserClient: vi.fn() }));

const clientAnswering = (result: { data: unknown; error: unknown }) =>
  ({
    from: () => ({
      select: () => ({ maybeSingle: () => Promise.resolve(result) }),
    }),
  }) as unknown as Client;

const signedIn = { getAccessToken: () => 'access-token' } as IContext;

beforeEach(() => {
  vi.mocked(createUserClient).mockReset();
  vi.restoreAllMocks();
});

describe('SupabaseJudgeSettingsReader', () => {
  it("returns the account's stored choice", async () => {
    vi.mocked(createUserClient).mockReturnValue(
      clientAnswering({
        data: { enabled: true, provider: 'subq' },
        error: null,
      })
    );
    await expect(
      new SupabaseJudgeSettingsReader(signedIn).read('usr_a')
    ).resolves.toEqual({ enabled: true, provider: 'subq' });
  });

  it('reads a provider outside the closed set as the platform default', async () => {
    vi.mocked(createUserClient).mockReturnValue(
      clientAnswering({ data: { enabled: true, provider: 'gpt' }, error: null })
    );
    await expect(
      new SupabaseJudgeSettingsReader(signedIn).read('usr_a')
    ).resolves.toEqual({ enabled: true, provider: null });
  });

  it('is off when the account has stored no choice', async () => {
    vi.mocked(createUserClient).mockReturnValue(
      clientAnswering({ data: null, error: null })
    );
    const warned = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    await expect(
      new SupabaseJudgeSettingsReader(signedIn).read('usr_a')
    ).resolves.toEqual(JUDGE_SETTINGS_OFF);
    expect(warned).not.toHaveBeenCalled();
  });

  it('is off when the read fails, and logs the message without the row', async () => {
    vi.mocked(createUserClient).mockReturnValue(
      clientAnswering({
        data: { enabled: true, provider: 'subq' },
        error: { message: 'boom' },
      })
    );
    const warned = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    await expect(
      new SupabaseJudgeSettingsReader(signedIn).read('usr_a')
    ).resolves.toEqual(JUDGE_SETTINGS_OFF);
    expect(warned).toHaveBeenCalledTimes(1);
    const line = String(warned.mock.calls[0]?.[0]);
    expect(line).toContain('boom');
    expect(line).not.toContain('subq');
  });

  it('is off without an access token, and reads nothing', async () => {
    const anonymous = { getAccessToken: () => undefined } as IContext;
    await expect(
      new SupabaseJudgeSettingsReader(anonymous).read('usr_a')
    ).resolves.toEqual(JUDGE_SETTINGS_OFF);
    expect(createUserClient).not.toHaveBeenCalled();
  });
});
