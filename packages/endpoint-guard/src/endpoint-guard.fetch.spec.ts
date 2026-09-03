import { afterEach, describe, expect, it, vi } from 'vitest';

const resolvePublicAddress = vi.fn();
vi.mock('./endpoint-guard.resolve.js', () => ({
  resolvePublicAddress: (...args: unknown[]) => resolvePublicAddress(...args),
  hostnameOf: (url: URL) =>
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname,
}));

const { createGuardedFetch, RedirectRefusedError } =
  await import('./endpoint-guard.fetch.js');

describe('createGuardedFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resolvePublicAddress.mockReset();
  });

  it('passes plain fetch through untouched when the policy allows private endpoints', () => {
    expect(createGuardedFetch({ denyPrivateEndpoints: false })).toBe(fetch);
    expect(resolvePublicAddress).not.toHaveBeenCalled();
  });

  it('pins an HTTP request to the checked address and forwards the original Host', async () => {
    resolvePublicAddress.mockResolvedValueOnce('93.184.216.34');
    const realFetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', realFetch);

    const guarded = createGuardedFetch({ denyPrivateEndpoints: true });
    await guarded('http://ollama.internal:11434/api/generate', {
      method: 'POST',
    });

    expect(resolvePublicAddress).toHaveBeenCalledWith('ollama.internal');
    const [calledUrl, calledInit] = realFetch.mock.calls[0]!;
    expect(calledUrl).toBe('http://93.184.216.34:11434/api/generate');
    expect((calledInit as RequestInit).method).toBe('POST');
    expect(new Headers((calledInit as RequestInit).headers).get('host')).toBe(
      'ollama.internal:11434'
    );
  });

  it('checks but does not pin an HTTPS request', async () => {
    resolvePublicAddress.mockResolvedValueOnce('93.184.216.34');
    const realFetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', realFetch);

    const guarded = createGuardedFetch({ denyPrivateEndpoints: true });
    await guarded('https://ollama.example.com/api/generate');

    expect(resolvePublicAddress).toHaveBeenCalledWith('ollama.example.com');
    const [calledUrl] = realFetch.mock.calls[0]!;
    expect(calledUrl).toBe('https://ollama.example.com/api/generate');
  });

  it('propagates a denial instead of ever calling the real fetch', async () => {
    const denial = new Error('private endpoint');
    resolvePublicAddress.mockRejectedValueOnce(denial);
    const realFetch = vi.fn();
    vi.stubGlobal('fetch', realFetch);

    const guarded = createGuardedFetch({ denyPrivateEndpoints: true });

    await expect(
      guarded('http://169.254.169.254/latest/meta-data/')
    ).rejects.toBe(denial);
    expect(realFetch).not.toHaveBeenCalled();
  });

  // Without this the guard checks one address and `fetch` quietly visits
  // another: an approved endpoint answering 307 to 169.254.169.254 reaches
  // the metadata service inside a single call, the whole check bypassed.
  it('never lets the runtime follow a redirect itself', async () => {
    resolvePublicAddress.mockResolvedValue('93.184.216.34');
    const realFetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', realFetch);

    const guarded = createGuardedFetch({ denyPrivateEndpoints: true });
    await guarded('http://ollama.internal:11434/api/generate');
    await guarded('https://ollama.example.com/api/generate');

    for (const [, init] of realFetch.mock.calls) {
      expect((init as RequestInit).redirect).toBe('manual');
    }
  });

  it.each([301, 302, 303, 307, 308])(
    'refuses a %s redirect instead of returning it as a result',
    async (status) => {
      resolvePublicAddress.mockResolvedValueOnce('93.184.216.34');
      const realFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        })
      );
      vi.stubGlobal('fetch', realFetch);

      const guarded = createGuardedFetch({ denyPrivateEndpoints: true });

      await expect(
        guarded('http://ollama.internal:11434/api/generate')
      ).rejects.toBeInstanceOf(RedirectRefusedError);
    }
  );

  it('passes a normal response through untouched', async () => {
    resolvePublicAddress.mockResolvedValueOnce('93.184.216.34');
    const ok = new Response('{"ok":true}', { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok));

    const guarded = createGuardedFetch({ denyPrivateEndpoints: true });

    await expect(
      guarded('http://ollama.internal:11434/api/generate')
    ).resolves.toBe(ok);
  });
});
