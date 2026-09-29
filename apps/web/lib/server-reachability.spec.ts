import { afterEach, describe, expect, it, vi } from 'vitest';

import { serverReachability } from './server-reachability';

/** Answers every probe with `status` and records the URLs asked for. */
const stubFetch = (status: number): string[] => {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      return new Response(null, { status });
    })
  );
  return asked;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('serverReachability', () => {
  it.each([
    ['http://zm-server:8787/mcp', 'http://zm-server:8787/healthz'],
    ['http://zm-server:8787/mcp/', 'http://zm-server:8787/healthz'],
    ['https://api.example.com', 'https://api.example.com/healthz'],
  ])(
    'probes the health path of the endpoint %s, not the endpoint itself',
    async (endpoint, health) => {
      vi.stubEnv('ZM_SERVER_URL', endpoint);
      const asked = stubFetch(200);
      expect(await serverReachability()).toEqual({
        reachable: true,
        status: 200,
      });
      expect(asked).toEqual([health]);
    }
  );

  it('reports a server that cannot be reached instead of throwing', async () => {
    vi.stubEnv('ZM_SERVER_URL', 'http://zm-server:8787/mcp');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      })
    );
    expect(await serverReachability()).toEqual({
      reachable: false,
      error: 'connect ECONNREFUSED',
    });
  });
});
