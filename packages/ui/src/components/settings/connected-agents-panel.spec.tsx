import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ConnectedAgentsPanel,
  type ConnectedAgentRow,
  type ConnectedAgentsLabels,
} from '@workspace/ui/components/settings/connected-agents-panel';

const labels: ConnectedAgentsLabels = {
  title: 'Connected agents',
  description: 'Agents you approved.',
  empty: 'No agent is connected.',
  unnamed: 'Unnamed agent',
  returnsTo: 'Returns to {address}',
  approvedOn: 'Approved {date}',
  lastUsed: 'Last used {date}',
  noSession: 'No active session',
  revoke: 'Revoke',
  confirmTitle: 'Revoke {name}?',
  confirmDescription: 'It loses access at once.',
  cancel: 'Cancel',
  confirm: 'Revoke',
  revoking: 'Revoking…',
};

const render = (agents: readonly ConnectedAgentRow[]) =>
  renderToStaticMarkup(
    <ConnectedAgentsPanel
      labels={labels}
      agents={agents}
      onRevoke={async () => ({ ok: true })}
    />
  );

const agent = (overrides: Partial<ConnectedAgentRow> = {}) => ({
  clientId: 'oac_one',
  name: 'Claude Code',
  returnAddress: 'http://127.0.0.1:53682/callback',
  approvedOn: '2026-10-05 09:00 UTC',
  lastUsed: '2026-10-05 10:00 UTC',
  ...overrides,
});

describe('ConnectedAgentsPanel', () => {
  it('says so when no agent is connected', () => {
    const html = render([]);
    expect(html).toContain('data-testid="connected-agents-empty"');
    expect(html).not.toContain('data-testid="connected-agent"');
  });

  it('lists two clients of the same name as two rows, told apart by address', () => {
    const html = render([
      agent(),
      agent({
        clientId: 'oac_two',
        returnAddress: 'http://127.0.0.1:41000/callback',
      }),
    ]);
    expect(html.match(/data-testid="connected-agent"/g)).toHaveLength(2);
    expect(html).toContain('Returns to http://127.0.0.1:53682/callback');
    expect(html).toContain('Returns to http://127.0.0.1:41000/callback');
    expect(html.match(/data-testid="connected-agent-revoke"/g)).toHaveLength(2);
  });

  it('shows when it was approved and last used, or that it holds no session', () => {
    expect(render([agent()])).toContain('Last used 2026-10-05 10:00 UTC');
    const idle = render([agent({ lastUsed: null })]);
    expect(idle).toContain('Approved 2026-10-05 09:00 UTC');
    expect(idle).toContain('No active session');
  });

  it('names a client that registered without a name', () => {
    expect(render([agent({ name: null })])).toContain('Unnamed agent');
  });
});
