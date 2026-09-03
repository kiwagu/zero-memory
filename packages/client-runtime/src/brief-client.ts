import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createAuthedTransport } from '@workspace/mcp-oauth-client';

import { resolveServerUrl } from './server-config.js';
import { parseToolPayload, toolErrorMessage } from './tool-result.js';

/**
 * One authenticated `build_context` call over streamable HTTP. Auth is OAuth —
 * the same file-backed token store the watcher's ingest client uses, so the
 * one `zero-memory-watcher login` that authorizes ingestion also authorizes
 * the briefing hooks (no separate credentials, no `.env`). Returns the parsed
 * tool payload; throws on transport or tool failure so the caller can stay
 * silent and never block a session.
 */
export const callBuildContext = async (
  args: Record<string, unknown>,
  serverUrl: string = resolveServerUrl()
): Promise<unknown> => {
  const client = new Client({ name: 'zero-memory-brief', version: '0.1.0' });
  await client.connect(createAuthedTransport(serverUrl));
  try {
    const result = await client.callTool({
      name: 'build_context',
      arguments: args,
    });
    if (result.isError) {
      throw new Error(`build_context failed: ${toolErrorMessage(result)}`);
    }
    // The payload is the first text block; instruction-framed notes (promoted
    // project rules, the remember reminder) ride in separate trailing blocks.
    return parseToolPayload(result);
  } finally {
    await client.close().catch(() => undefined);
  }
};
