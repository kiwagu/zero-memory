import { afterEach, describe, expect, it, vi } from 'vitest';

import { healthzUrlOf, probeServer } from './server-probe.js';

describe('healthzUrlOf', () => {
  it('derives /healthz from the MCP url (with or without trailing slash)', () => {
    expect(healthzUrlOf('http://zm.example.test:8787/mcp')).toBe(
      'http://zm.example.test:8787/healthz'
    );
    expect(healthzUrlOf('http://zm.example.test:8787/mcp/')).toBe(
      'http://zm.example.test:8787/healthz'
    );
    expect(healthzUrlOf('https://zm.example.com/mcp')).toBe(
      'https://zm.example.com/healthz'
    );
  });
});

describe('probeServer — liveness branch (classifies before any auth)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (impl: () => Promise<unknown>) =>
    vi.stubGlobal('fetch', vi.fn(impl));

  it('is server-down when healthz is unreachable', async () => {
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    const probe = await probeServer('http://zm.example.test:8787/mcp', 50);
    expect(probe.state).toBe('server-down');
    expect(probe.fix).toMatch(/unreachable|restart/i);
  });

  it('is timeout when healthz aborts', async () => {
    stubFetch(() => {
      const e = new Error('timed out');
      e.name = 'TimeoutError';
      return Promise.reject(e);
    });
    expect(
      (await probeServer('http://zm.example.test:8787/mcp', 50)).state
    ).toBe('timeout');
  });

  it('is server-error on a healthz 5xx', async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 503 }));
    expect(
      (await probeServer('http://zm.example.test:8787/mcp', 50)).state
    ).toBe('server-error');
  });

  it('is server-down on a healthz 4xx', async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 404 }));
    expect(
      (await probeServer('http://zm.example.test:8787/mcp', 50)).state
    ).toBe('server-down');
  });

  it('every non-ok state carries a concrete fix', async () => {
    stubFetch(() => Promise.reject(new Error('down')));
    const probe = await probeServer('http://zm.example.test:8787/mcp', 50);
    expect(probe.state).not.toBe('ok');
    expect(probe.fix.length).toBeGreaterThan(0);
  });
});

describe('probeServer — an unconfigured machine is its own state', () => {
  it('does not probe (nothing to probe) and says how to configure', async () => {
    const probe = await probeServer(null, 50);
    expect(probe.state).toBe('not-configured');
    expect(probe.serverUrl).toBeNull();
    expect(probe.fix).toContain('zero-memory-watcher login');
  });

  it('names the endpoint every other result is about', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('down')))
    );
    const probe = await probeServer('https://memory.example.com/mcp', 50);
    expect(probe.serverUrl).toBe('https://memory.example.com/mcp');
    vi.unstubAllGlobals();
  });
});
