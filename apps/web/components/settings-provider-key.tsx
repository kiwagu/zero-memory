'use client';

import {
  ProviderKeyPanel,
  type ProviderKeyLabels,
  type ProviderKeyState,
} from '@workspace/ui/components/settings/provider-key-panel';

const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'xai', label: 'Grok (xAI)' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'moonshot', label: 'Kimi (Moonshot)' },
  { value: 'ollama', label: 'Ollama' },
] as const;

/** Ollama runs wherever the user installed it, so its endpoint is theirs to give. */
const ENDPOINT_PROVIDERS = ['ollama'] as const;

const ENDPOINT = '/settings/provider-key';

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
export function SettingsProviderKey({
  labels,
  current,
}: {
  labels: ProviderKeyLabels;
  current: ProviderKeyState | null;
}) {
  return (
    <ProviderKeyPanel
      labels={labels}
      providers={PROVIDERS}
      endpointProviders={ENDPOINT_PROVIDERS}
      current={current}
      onSave={async ({ provider, apiKey, model, baseUrl }) => {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider, apiKey, model, baseUrl }),
        });
        return response.ok ? { ok: true } : failed(response);
      }}
      onRevoke={async () => {
        const response = await fetch(ENDPOINT, { method: 'DELETE' });
        return response.ok ? { ok: true } : failed(response);
      }}
    />
  );
}
