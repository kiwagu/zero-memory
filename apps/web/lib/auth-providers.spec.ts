import { describe, expect, it, vi } from 'vitest';

import { readEnabledProviders } from './auth-providers';

const env = { url: 'http://127.0.0.1:55321', anonKey: 'anon-key' };

const settingsResponse = (external: Record<string, boolean>, status = 200) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify({ external }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
  ) as unknown as typeof fetch;

describe('readEnabledProviders', () => {
  it('lists only the providers the instance switched on', async () => {
    const fetchImpl = settingsResponse({
      github: true,
      google: false,
      email: true,
    });
    await expect(readEnabledProviders(env, fetchImpl)).resolves.toEqual([
      'github',
    ]);
  });

  it('keeps the display order fixed whatever the settings order', async () => {
    const fetchImpl = settingsResponse({ google: true, github: true });
    await expect(readEnabledProviders(env, fetchImpl)).resolves.toEqual([
      'github',
      'google',
    ]);
  });

  it('asks the public settings endpoint with the anon key', async () => {
    const fetchImpl = settingsResponse({ github: true });
    await readEnabledProviders(env, fetchImpl);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:55321/auth/v1/settings');
    expect(new Headers(init.headers).get('apikey')).toBe('anon-key');
    expect(init.cache).toBe('no-store');
  });

  it('ignores providers the dashboard cannot draw', async () => {
    const fetchImpl = settingsResponse({ apple: true, email: true });
    await expect(readEnabledProviders(env, fetchImpl)).resolves.toEqual([]);
  });

  it('shows no buttons when the settings endpoint fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = settingsResponse({ github: true }, 500);
    await expect(readEnabledProviders(env, fetchImpl)).resolves.toEqual([]);
  });

  it('shows no buttons when the network is down', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(readEnabledProviders(env, fetchImpl)).resolves.toEqual([]);
  });

  it('shows no buttons when the body is not the settings shape', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(
      async () => new Response('{"external": "nope"}', { status: 200 })
    ) as unknown as typeof fetch;
    await expect(readEnabledProviders(env, fetchImpl)).resolves.toEqual([]);
  });
});
