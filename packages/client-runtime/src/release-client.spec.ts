import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callRelease, fetchDeployedVersion } from './release-client.js';

vi.mock('@workspace/mcp-oauth-client', () => ({
  createAuthedTransport: (url: string) =>
    new StreamableHTTPClientTransport(new URL(url)),
}));

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => resolve(body));
  });

let server: Server | null = null;
const serve = async (handler: RequestListener): Promise<string> => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
afterEach(async () => {
  const running = server;
  server = null;
  if (running) {
    running.closeAllConnections();
    await new Promise((resolve) => running.close(resolve));
  }
});

describe('fetchDeployedVersion', () => {
  it('reads the version a url answers', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: 'v1.0.0+abc1234' }));
    });
    expect(
      await fetchDeployedVersion(`${base}/healthz`, 'version', 2000)
    ).toEqual({
      version: '1.0.0',
      build: 'abc1234',
    });
  });

  it('answers null for an error status, a body that is not JSON, and a url it will not read', async () => {
    let asked = 0;
    const base = await serve((req, res) => {
      asked += 1;
      if (req.url === '/down') {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    expect(
      await fetchDeployedVersion(`${base}/down`, 'version', 2000)
    ).toBeNull();
    expect(
      await fetchDeployedVersion(`${base}/text`, 'version', 2000)
    ).toBeNull();
    expect(asked).toBe(2);
    expect(
      await fetchDeployedVersion(
        'http://api.example.com/healthz',
        'version',
        2000
      )
    ).toBeNull();
    expect(
      await fetchDeployedVersion(
        'https://u:p@api.example.com/healthz',
        'version',
        2000
      )
    ).toBeNull();
  });

  it('gives up at its deadline when the url never answers', async () => {
    const base = await serve(() => {
      // Up, and silent.
    });
    const started = Date.now();
    expect(
      await fetchDeployedVersion(`${base}/healthz`, 'version', 1500)
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500 + 3000);
  }, 15_000);
});

describe('callRelease', () => {
  it('gives up at its deadline even while connecting, and lets go of the request', async () => {
    let stalled = 0;
    const base = await serve((req, res) => {
      void readBody(req).then((raw) => {
        const message = JSON.parse(raw || '{}') as {
          id?: number;
          method?: string;
          params?: { protocolVersion?: string };
        };
        if (message.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: message.params?.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'stalled', version: '0' },
              },
            })
          );
          return;
        }
        stalled += 1; // every later request hangs
      });
    });
    // Long enough to outlast a cold initialize round trip (see board-client.spec.ts).
    const deadlineMs = 1500;
    const started = Date.now();
    await expect(
      callRelease(
        { action: 'settings', scope: 'proj.x' },
        deadlineMs,
        `${base}/mcp`
      )
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(deadlineMs + 3000);
    expect(stalled).toBeGreaterThan(0);
  }, 15_000);
});
