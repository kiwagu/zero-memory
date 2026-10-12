import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createAuthedTransport } from './mcp-client.js';
import { OAuthStateStore } from './state-store.js';

interface TestServer {
  url: string;
  /** Session ids the server saw end through the protocol's DELETE. */
  ended: string[];
  /** DELETE requests that reached the server, answered or not. */
  deletes(): number;
  stop(): Promise<void>;
}

/**
 * A real MCP server over HTTP with sessions, the shape the zero-memory server
 * speaks. `holdDelete` leaves every DELETE unanswered, the way a stalled
 * server would.
 */
const startServer = async (
  options: { holdDelete?: boolean } = {}
): Promise<TestServer> => {
  const ended: string[] = [];
  const held: ServerResponse[] = [];
  let deletes = 0;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessionclosed: (sessionId) => {
      ended.push(sessionId);
    },
  });
  await new McpServer({ name: 'test-server', version: '0.0.0' }).connect(
    transport
  );
  const http: Server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      if (request.method === 'DELETE') {
        deletes += 1;
        if (options.holdDelete) {
          held.push(response);
          return;
        }
      }
      void transport.handleRequest(request, response);
    }
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    ended,
    deletes: () => deletes,
    stop: async () => {
      for (const response of held) {
        response.destroy();
      }
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
};

/** A token store that already holds a login for `serverUrl`. */
const loggedInStore = (serverUrl: string): OAuthStateStore => {
  const store = new OAuthStateStore(
    join(mkdtempSync(join(tmpdir(), 'zm-oauth-')), 'oauth.json')
  );
  store.update(serverUrl, {
    tokens: { access_token: 'a-token', token_type: 'Bearer' },
  });
  return store;
};

describe('createAuthedTransport', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('ends its session on the server when the client closes', async () => {
    server = await startServer();
    const transport = createAuthedTransport(
      server.url,
      loggedInStore(server.url)
    );
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);
    const sessionId = transport.sessionId;
    expect(sessionId).toBeDefined();

    await client.close();

    expect(server.ended).toEqual([sessionId]);
  });

  it('still closes promptly when the server never answers the end of the session', async () => {
    server = await startServer({ holdDelete: true });
    const transport = createAuthedTransport(
      server.url,
      loggedInStore(server.url)
    );
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);

    const started = Date.now();
    await client.close();

    expect(server.deletes()).toBe(1);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(server.ended).toEqual([]);
  });
});
