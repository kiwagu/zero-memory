'use client';

import * as React from 'react';
import { KeyRound, Trash2 } from 'lucide-react';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Button } from '@workspace/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';

export interface ProviderKeyLabels {
  title: string;
  description: string;
  providerLabel: string;
  keyLabel: string;
  keyPlaceholder: string;
  modelLabel: string;
  modelPlaceholder: string;
  baseUrlLabel: string;
  baseUrlPlaceholder: string;
  save: string;
  saving: string;
  /** Template with {provider} and {hint}. */
  installed: string;
  revoke: string;
  revoking: string;
  hint: string;
}

export interface ProviderKeyState {
  provider: string;
  model: string | null;
  baseUrl: string | null;
  hint: string;
}

export type ProviderKeyPanelProps = {
  labels: ProviderKeyLabels;
  providers: readonly { value: string; label: string }[];
  /**
   * Providers whose endpoint the user supplies rather than the vendor (Ollama).
   * For these the panel shows a base-URL field and treats the key as optional —
   * a local endpoint has no key to give.
   */
  endpointProviders?: readonly string[];
  /** Null when the user has no key stored. */
  current: ProviderKeyState | null;
  onSave: (input: {
    provider: string;
    apiKey: string;
    model: string | null;
    baseUrl: string | null;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  onRevoke: () => Promise<{ ok: true } | { ok: false; error: string }>;
};

/**
 * ProviderKeyPanel — install, replace or withdraw your own model-provider key.
 *
 * The key field is write-only by construction: a stored key is described by
 * its provider and last four characters, never rendered back into the input.
 * There is nothing here that can display a key, so no state change can
 * accidentally reveal one.
 */
export function ProviderKeyPanel({
  labels,
  providers,
  endpointProviders = [],
  current,
  onSave,
  onRevoke,
}: ProviderKeyPanelProps) {
  const [provider, setProvider] = React.useState(
    current?.provider ?? providers[0]?.value ?? 'anthropic'
  );
  const [apiKey, setApiKey] = React.useState('');
  const [model, setModel] = React.useState(current?.model ?? '');
  const [baseUrl, setBaseUrl] = React.useState(current?.baseUrl ?? '');
  const [busy, setBusy] = React.useState<'save' | 'revoke' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [installed, setInstalled] = React.useState(current);

  // A provider whose endpoint the user supplies (Ollama) needs a base URL and
  // has no key of its own; every other provider is the reverse.
  const needsBaseUrl = endpointProviders.includes(provider);
  const canSave = needsBaseUrl ? baseUrl.trim() !== '' : apiKey.trim() !== '';

  const save = async () => {
    setBusy('save');
    setError(null);
    const result = await onSave({
      provider,
      apiKey,
      model: model === '' ? null : model,
      baseUrl: needsBaseUrl && baseUrl !== '' ? baseUrl : null,
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Clear the field the moment it is accepted: leaving the key in the DOM
    // after it has been stored serves nothing and survives in memory dumps,
    // screenshots and shoulder-surfing alike.
    setInstalled({
      provider,
      model: model === '' ? null : model,
      baseUrl: needsBaseUrl && baseUrl !== '' ? baseUrl : null,
      hint: apiKey.slice(-4),
    });
    setApiKey('');
  };

  const revoke = async () => {
    setBusy('revoke');
    setError(null);
    const result = await onRevoke();
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setInstalled(null);
    setApiKey('');
  };

  return (
    <Card data-testid="settings-provider-key">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> {labels.title}
        </CardTitle>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {installed ? (
          <Alert data-testid="settings-provider-key-installed">
            <AlertDescription className="flex items-center justify-between gap-3">
              <span>
                {labels.installed
                  .replace('{provider}', installed.provider)
                  .replace('{hint}', installed.hint)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void revoke()}
                data-testid="settings-provider-key-revoke"
              >
                <Trash2 className="size-4" />
                {busy === 'revoke' ? labels.revoking : labels.revoke}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="provider-key-provider">
              {labels.providerLabel}
            </Label>
            <select
              id="provider-key-provider"
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              data-testid="settings-provider-key-provider"
            >
              {providers.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="provider-key-model">{labels.modelLabel}</Label>
            <Input
              id="provider-key-model"
              value={model}
              placeholder={labels.modelPlaceholder}
              onChange={(event) => setModel(event.target.value)}
              data-testid="settings-provider-key-model"
            />
          </div>
        </div>

        {needsBaseUrl ? (
          <div className="space-y-1.5">
            <Label htmlFor="provider-key-base-url">{labels.baseUrlLabel}</Label>
            <Input
              id="provider-key-base-url"
              value={baseUrl}
              placeholder={labels.baseUrlPlaceholder}
              onChange={(event) => setBaseUrl(event.target.value)}
              data-testid="settings-provider-key-base-url"
            />
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="provider-key-value">{labels.keyLabel}</Label>
          <Input
            id="provider-key-value"
            // A password field, so it is masked, kept out of autofill history
            // and not read aloud by assistive tech.
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            placeholder={labels.keyPlaceholder}
            onChange={(event) => setApiKey(event.target.value)}
            data-testid="settings-provider-key-input"
          />
        </div>

        {error ? (
          <Alert
            variant="destructive"
            data-testid="settings-provider-key-error"
          >
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">{labels.hint}</p>
          <Button
            disabled={busy !== null || !canSave}
            onClick={() => void save()}
            data-testid="settings-provider-key-save"
          >
            {busy === 'save' ? labels.saving : labels.save}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
