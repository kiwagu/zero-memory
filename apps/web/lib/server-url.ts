/**
 * Where the dashboard's own process reaches the zero-memory server.
 *
 * ZM_SERVER_URL is the FULL MCP endpoint (the watcher/hooks convention), e.g.
 * https://memory.example.com/mcp — not a base URL. Unset means the server
 * next door: a local dev run, or the compose service that injects the
 * in-network address.
 */
export function mcpEndpoint(): string {
  return (process.env.ZM_SERVER_URL ?? 'http://localhost:8787/mcp').replace(
    /\/$/,
    ''
  );
}

/** The same server's root, for its routes outside MCP (the consent API). */
export function serverBaseUrl(): string {
  return mcpEndpoint().replace(/\/mcp$/, '');
}
