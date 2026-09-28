import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});

describe('probeServer — an unconfigured machine is its own state', () => {
  it('does not probe (nothing to probe) and says how to configure', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('never asked')));
    vi.stubGlobal('fetch', fetchSpy);
    const probe = await probeServer(null, 50);
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
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

/**
 * Past a live healthz, the state is decided by one real authenticated connect:
 * a server that refuses this machine's credentials must read as
 * "unauthenticated" (the fix is `login`), and one that fails the connect for
 * any other reason as "server-error" (the fix is on the server) — never the
 * other way round, or the session is told to log in to a broken server.
 */
describe('probeServer — auth branch (the server is up)', () => {
  let stateDir: string;
  let previousState: string | undefined;
  let server: Server | null = null;

  /** A server whose healthz answers and whose MCP endpoint answers `status`. */
  const serverAnswering = async (status: number): Promise<string> => {
    server = createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      res.writeHead(status);
      res.end(status === 401 ? '{"error":"invalid_token"}' : 'boom');
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve)
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  };

  beforeEach(() => {
    // No stored credentials: the machine's own token store stays out of it.
    stateDir = mkdtempSync(join(tmpdir(), 'zm-probe-auth-'));
    previousState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
  });

  afterEach(async () => {
    const running = server;
    server = null;
    if (running) {
      running.closeAllConnections();
      await new Promise((resolve) => running.close(resolve));
    }
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('is unauthenticated when the server refuses this machine', async () => {
    const probe = await probeServer(await serverAnswering(401), 2000);
    expect(probe.state).toBe('unauthenticated');
    expect(probe.fix).toContain('zero-memory-watcher login');
  });

  it('is server-error, not unauthenticated, when the server fails the connect', async () => {
    const probe = await probeServer(await serverAnswering(500), 2000);
    expect(probe.state).toBe('server-error');
  });
});
