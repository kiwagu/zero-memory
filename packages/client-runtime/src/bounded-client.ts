import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { createAuthedTransport } from '@workspace/mcp-oauth-client';

/**
 * One authenticated exchange with the server, bounded as a whole. A hook runs
 * inside its client's own timeout, so a server that stalls must not hold the
 * process past it: every request carries the deadline, and closing the client
 * when it passes aborts whatever is still in flight — connecting included,
 * whose last step is a notification the request timeout does not cover.
 * `exchange` makes its calls with the `options` it is handed; the client is
 * closed however it ends.
 */
export const withBoundedClient = async <T>(
  name: string,
  serverUrl: string,
  timeoutMs: number,
  exchange: (client: Client, options: RequestOptions) => Promise<T>
): Promise<T> => {
  const options = { timeout: timeoutMs };
  const client = new Client({ name, version: '0.1.0' });
  const deadline = setTimeout(() => {
    void client.close().catch(() => undefined);
  }, timeoutMs);
  try {
    await client.connect(createAuthedTransport(serverUrl), options);
    return await exchange(client, options);
  } finally {
    clearTimeout(deadline);
    await client.close().catch(() => undefined);
  }
};
