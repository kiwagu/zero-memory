'use client';

import { useRouter } from 'next/navigation';

import {
  JudgeProviderPanel,
  type JudgeProviderLabels,
  type JudgeProviderState,
} from '@workspace/ui/components/settings/judge-provider-panel';

const ENDPOINT = '/settings/judge-provider';

type Result = { ok: true } | { ok: false; error: string };

const failed = async (response: Response): Promise<Result> => {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: body.error ?? 'Request failed.' };
};

/**
 * Client wrapper: the panel is presentation, the route handler does the work.
 *
 * The key travels in a request BODY rather than as a server-action argument —
 * Next logs server-action arguments in development, which would put the key
 * in plaintext into the dev server's log. A body is not logged.
 */
export function SettingsJudgeProvider({
  labels,
  current,
}: {
  labels: JudgeProviderLabels;
  current: JudgeProviderState;
}) {
  const router = useRouter();
  return (
    <JudgeProviderPanel
      labels={labels}
      current={current}
      onSettings={async (input) => {
        const response = await fetch(ENDPOINT, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!response.ok) {
          return failed(response);
        }
        router.refresh();
        return { ok: true };
      }}
      onSaveKey={async ({ provider, apiKey, model }) => {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider, apiKey, model }),
        });
        return response.ok ? { ok: true } : failed(response);
      }}
      onRevokeKey={async () => {
        const response = await fetch(ENDPOINT, { method: 'DELETE' });
        return response.ok ? { ok: true } : failed(response);
      }}
    />
  );
}
