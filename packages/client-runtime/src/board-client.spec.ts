import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callCardBranches } from './board-client.js';

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

describe('callCardBranches', () => {
  let server: Server | null = null;

  afterEach(async () => {
    const running = server;
    server = null;
    if (running) {
      running.closeAllConnections();
      await new Promise((resolve) => running.close(resolve));
    }
  });

  it('gives up at its deadline even while connecting, and lets go of the request', async () => {
    let stalled = 0;
    let stalledClosed = false;
    server = createServer((req, res) => {
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
        // Every later request hangs: the server is up but no longer answers.
        stalled += 1;
        res.on('close', () => {
          if (!res.writableEnded) stalledClosed = true;
        });
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    // The deadline has to outlast the initialize round trip, or it fires
    // before the stalled request exists and the test proves nothing about it.
    // A cold runner can take several hundred milliseconds for that first
    // exchange, so the budget leaves room for it.
    const deadlineMs = 1500;
    const started = Date.now();
    await expect(
      callCardBranches('proj.x', 19, deadlineMs, `http://127.0.0.1:${port}/mcp`)
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(deadlineMs + 3000);
    expect(stalled).toBeGreaterThan(0);
    await expect.poll(() => stalledClosed).toBe(true);
  }, 15_000);
});
