import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CONTRACT_VERSION } from '@workspace/contracts';
import type { ICommandBus, IQueryBus } from '@workspace/cqrs';
import { describe, expect, it } from 'vitest';

import { buildMcpServer, CONTRACT_CAPABILITY_KEY } from './mcp-server.js';

/**
 * The handshake is asserted through a REAL client over a linked in-memory
 * transport rather than by reading the server's internals: what matters is
 * what a client actually ends up holding after initialize, and the SDK client
 * parses the result against a closed schema. A test that peeked at the server
 * object would still pass if the capability were dropped in transit — which is
 * precisely the failure mode that ruled out announcing the version through
 * `serverInfo`.
 */
describe('initialize handshake', () => {
  it('announces the contract version to a client that parses the result', async () => {
    const noop = { execute: () => Promise.resolve(undefined) };
    const server = buildMcpServer({
      commandBus: noop as unknown as ICommandBus,
      queryBus: noop as unknown as IQueryBus,
      runInToolContext: (fn) => fn(),
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contract-spec', version: '0.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const experimental = client.getServerCapabilities()?.experimental;
      expect(experimental?.[CONTRACT_CAPABILITY_KEY]).toEqual({
        version: CONTRACT_VERSION,
      });
      expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
