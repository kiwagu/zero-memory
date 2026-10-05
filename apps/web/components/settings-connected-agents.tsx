'use client';

import { useRouter } from 'next/navigation';

import {
  ConnectedAgentsPanel,
  type ConnectedAgentRow,
  type ConnectedAgentsLabels,
} from '@workspace/ui/components/settings/connected-agents-panel';

/**
 * Client wrapper: the panel is presentation, the route handler revokes, and
 * the page re-reads the list from the server afterwards.
 */
export function SettingsConnectedAgents({
  labels,
  agents,
}: {
  labels: ConnectedAgentsLabels;
  agents: readonly ConnectedAgentRow[];
}) {
  const router = useRouter();
  return (
    <ConnectedAgentsPanel
      labels={labels}
      agents={agents}
      onRevoke={async (clientId) => {
        const response = await fetch('/settings/connected-agents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId }),
        });
        if (!response.ok) {
          const message = await response.text().catch(() => '');
          return { ok: false, error: message || 'Request failed.' };
        }
        router.refresh();
        return { ok: true };
      }}
    />
  );
}
