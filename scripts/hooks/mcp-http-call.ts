/**
 * Minimal MCP tool-call helper for the hook scripts: connect over streamable
 * HTTP with OAuth (the shared file-backed token store), run one tool, close.
 *
 * Authentication is OAuth — the same tokens the watcher uses. Authorize the
 * machine once with `zero-memory-watcher login` (or `bun scripts/zm-login.ts`);
 * until then a hook simply fails (and its caller exits silently).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { resolveServerUrl } from '@workspace/client-runtime';
import { createAuthedTransport } from '@workspace/mcp-oauth-client';

export interface HookEnv {
  serverUrl: string;
}

export const readHookEnv = (): HookEnv => ({
  // Same answer the shipped clients use: the env override, else this machine's
  // stored server, else an error naming the fix — never an invented address.
  serverUrl: resolveServerUrl(),
});

/** One authenticated MCP tool call; returns the parsed tool payload. */
export const callMcpTool = async (
  env: HookEnv,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> => {
  const client = new Client({ name: 'zero-memory-hook', version: '0.1.0' });
  await client.connect(createAuthedTransport(env.serverUrl));
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (
      (result.content ?? []) as Array<{ type: string; text?: string }>
    )
      .filter((item) => item.type === 'text' && item.text)
      .map((item) => item.text!)
      .join('\n');
    if (result.isError) {
      throw new Error(`Tool ${name} failed: ${text}`);
    }
    // The first text block is the JSON payload (a footer block may follow).
    return JSON.parse(text.split('\n---')[0]!.trim());
  } finally {
    await client.close().catch(() => undefined);
  }
};

/** Reads the hook's JSON payload from stdin. */
export const readStdinJson = async (): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
};
