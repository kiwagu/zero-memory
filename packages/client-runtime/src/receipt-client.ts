import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  sessionReceiptOutputSchema,
  type SessionReceiptOutput,
} from '@workspace/contracts';
import { createAuthedTransport } from '@workspace/mcp-oauth-client';

import { resolveServerUrl } from './server-config.js';
import { toolErrorMessage } from './tool-result.js';

/**
 * One authenticated `session_receipt` call over streamable HTTP — the same
 * OAuth token store as ingest and brief, so the one `zero-memory-watcher
 * login` covers the receipt hook too. Throws on transport or tool failure so
 * the caller can degrade to its client-side counters.
 */
export const callSessionReceipt = async (
  since: string,
  serverUrl: string = resolveServerUrl()
): Promise<SessionReceiptOutput> => {
  const client = new Client({ name: 'zero-memory-receipt', version: '0.1.0' });
  await client.connect(createAuthedTransport(serverUrl));
  try {
    const result = await client.callTool({
      name: 'session_receipt',
      arguments: { since },
    });
    const text = (
      (result.content ?? []) as Array<{ type: string; text?: string }>
    )
      .filter((item) => item.type === 'text' && item.text)
      .map((item) => item.text!)
      .join('\n');
    if (result.isError) {
      throw new Error(`session_receipt failed: ${toolErrorMessage(result)}`);
    }
    return sessionReceiptOutputSchema.parse(JSON.parse(text));
  } finally {
    await client.close().catch(() => undefined);
  }
};
