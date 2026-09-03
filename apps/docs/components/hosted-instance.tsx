import { hostedDashboardUrl, hostedMcpUrl } from '@/lib/client-bundle';

/**
 * The hosted instance's addresses, rendered from the build's configuration
 * rather than typed into the prose — so a page, its command blocks and its
 * download button always name the same deployment.
 */
export function HostedMcpEndpoint() {
  return <code>{hostedMcpUrl()}</code>;
}

export function HostedDashboardLink() {
  const url = hostedDashboardUrl();
  return <a href={url}>{url.replace(/^https?:\/\//, '')}</a>;
}

/** `claude mcp add …` for the configured instance — the whole minimum setup. */
export function HostedConnectCommand({
  client = 'claude',
}: {
  client?: 'claude' | 'codex' | 'cursor';
}) {
  const url = hostedMcpUrl();
  const command =
    client === 'codex'
      ? `codex mcp add zero-memory --url ${url}`
      : client === 'cursor'
        ? `# ~/.cursor/mcp.json → mcpServers."zero-memory".url\n${url}`
        : `claude mcp add --scope user --transport http zero-memory ${url}`;
  return (
    <pre className="not-prose bg-fd-secondary text-fd-secondary-foreground my-6 overflow-x-auto rounded-lg p-4 text-sm">
      <code>{command}</code>
    </pre>
  );
}
