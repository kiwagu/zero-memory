#!/usr/bin/env bun
/**
 * One-time OAuth login for the zero-memory ingest clients (hooks + watcher run
 * from a repo clone). Registers this machine with the MCP server's embedded
 * OAuth server and stores the token pair; afterwards hooks and the watcher run
 * headlessly and refresh on their own.
 *
 * Usage: bun scripts/zm-login.ts            # this machine's stored server
 *        ZM_SERVER_URL=<url> bun scripts/zm-login.ts   # one-off override
 *
 * (The compiled watcher binary exposes the same flow as
 * `zero-memory-watcher login <url>`, which also STORES the address.)
 */
import { resolveServerUrl } from '@workspace/client-runtime';
import { runLogin } from '@workspace/mcp-oauth-client';

// No baked address: the env override, else this machine's stored server, else
// an error naming the fix — the same answer every other client resolves.
const serverUrl = resolveServerUrl();

runLogin(serverUrl).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
