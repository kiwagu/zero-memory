/**
 * The MCP endpoint the dashboard calls, reduced to the server's own health
 * URL. `ZM_SERVER_URL` is the FULL endpoint by convention (…/mcp), so the
 * suffix is stripped rather than appended to.
 */
export const healthUrlFrom = (endpoint: string): string =>
  `${endpoint.replace(/\/$/, '').replace(/\/mcp$/, '')}/healthz`;

export interface ServerReachability {
  reachable: boolean;
  status?: number;
  error?: string;
}

/**
 * One short probe of the memory server from inside this container. Any
 * failure is reported, never thrown: an unreachable server is a state this
 * endpoint exists to describe, not an error it should hide behind a 500.
 */
export const serverReachability = async (
  timeoutMs = 3000
): Promise<ServerReachability> => {
  const url = healthUrlFrom(
    process.env.ZM_SERVER_URL ?? 'http://localhost:8787/mcp'
  );
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    return { reachable: response.ok, status: response.status };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
