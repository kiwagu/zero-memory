'use client';

import * as React from 'react';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Button } from '@workspace/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workspace/ui/components/dialog';

export interface ConnectedAgentsLabels {
  title: string;
  description: string;
  /** Shown when no agent holds an approval on this account. */
  empty: string;
  /** The name shown for a client that registered without one. */
  unnamed: string;
  /** `{address}` is replaced with the return address that was approved. */
  returnsTo: string;
  /** `{date}` is replaced with when the agent was approved. */
  approvedOn: string;
  /** `{date}` is replaced with when one of its sessions was last active. */
  lastUsed: string;
  /** Shown instead of `lastUsed` when the agent holds no session. */
  noSession: string;
  revoke: string;
  /** `{name}` is replaced with the agent's name. */
  confirmTitle: string;
  confirmDescription: string;
  cancel: string;
  confirm: string;
  revoking: string;
}

/** One approved client, with its dates already formatted by the caller. */
export interface ConnectedAgentRow {
  clientId: string;
  name: string | null;
  returnAddress: string;
  approvedOn: string;
  /** Null when the agent holds no session right now. */
  lastUsed: string | null;
}

export type ConnectedAgentsPanelProps = {
  labels: ConnectedAgentsLabels;
  agents: readonly ConnectedAgentRow[];
  /**
   * Withdraws the approval and ends the agent's sessions. On `ok` the caller
   * refreshes the list; on failure the message shows and the dialog stays
   * open.
   */
  onRevoke: (
    clientId: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
};

/**
 * ConnectedAgentsPanel — the agents this account has approved on the consent
 * screen, one row per client, each with the return address it was approved
 * for, so two clients with the same name stay told apart. Revoke asks once,
 * then the agent loses access at once and must be approved again to
 * reconnect. Mechanism only: copy arrives translated and the work is the
 * caller's `onRevoke`.
 */
export function ConnectedAgentsPanel({
  labels,
  agents,
  onRevoke,
}: ConnectedAgentsPanelProps) {
  const [target, setTarget] = React.useState<ConnectedAgentRow | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const nameOf = (agent: ConnectedAgentRow) => agent.name ?? labels.unnamed;

  const close = () => {
    setTarget(null);
    setError(null);
  };

  const runRevoke = async () => {
    if (!target) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await onRevoke(target.clientId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    close();
  };

  return (
    <Card data-testid="settings-connected-agents">
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {agents.length === 0 ? (
          <p
            className="text-muted-foreground text-sm"
            data-testid="connected-agents-empty"
          >
            {labels.empty}
          </p>
        ) : (
          <ul className="space-y-2">
            {agents.map((agent) => (
              <li
                key={agent.clientId}
                data-testid="connected-agent"
                data-client-id={agent.clientId}
                className="flex items-center justify-between gap-4 rounded-md border p-3 text-sm"
              >
                <span className="min-w-0">
                  <span
                    className="block font-medium"
                    data-testid="connected-agent-name"
                  >
                    {nameOf(agent)}
                  </span>
                  <span
                    className="text-muted-foreground block font-mono text-xs break-all"
                    data-testid="connected-agent-address"
                  >
                    {labels.returnsTo.replace('{address}', agent.returnAddress)}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {labels.approvedOn.replace('{date}', agent.approvedOn)}
                    {' · '}
                    <span data-testid="connected-agent-last-used">
                      {agent.lastUsed === null
                        ? labels.noSession
                        : labels.lastUsed.replace('{date}', agent.lastUsed)}
                    </span>
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  data-testid="connected-agent-revoke"
                  onClick={() => setTarget(agent)}
                >
                  {labels.revoke}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog
        open={target !== null}
        onOpenChange={(next) => {
          if (!next && !busy) {
            close();
          }
        }}
      >
        <DialogContent data-testid="connected-agent-dialog">
          <DialogHeader>
            <DialogTitle>
              {labels.confirmTitle.replace(
                '{name}',
                target ? nameOf(target) : ''
              )}
            </DialogTitle>
            <DialogDescription>{labels.confirmDescription}</DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert variant="destructive" data-testid="connected-agent-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              {labels.cancel}
            </DialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              data-testid="connected-agent-confirm"
              onClick={() => void runRevoke()}
            >
              {busy ? labels.revoking : labels.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
