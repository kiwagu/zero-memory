import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  rememberOutputSchema,
  type RememberInput,
  type RememberOutput,
} from '@workspace/contracts';
import { createAuthedTransport } from '@workspace/mcp-oauth-client';

import { resolveServerUrl } from './server-config.js';
import { parseToolPayload, toolErrorMessage } from './tool-result.js';

/**
 * One authenticated `remember` call over streamable HTTP — the same OAuth
 * token store the watcher's other subcommands use, so the one
 * `zero-memory-watcher login` covers quick-capture too. Throws on transport
 * failure; a tool-level error (e.g. the content guard) is thrown with the
 * server's message so the CLI can show the real reason.
 */
export const callRemember = async (
  input: RememberInput,
  serverUrl: string = resolveServerUrl()
): Promise<RememberOutput> => {
  const client = new Client({ name: 'zero-memory-capture', version: '0.1.0' });
  await client.connect(createAuthedTransport(serverUrl));
  try {
    const result = await client.callTool({
      name: 'remember',
      arguments: input,
    });
    if (result.isError) {
      throw new Error(toolErrorMessage(result) || 'remember failed');
    }
    return rememberOutputSchema.parse(parseToolPayload(result));
  } finally {
    await client.close().catch(() => undefined);
  }
};
