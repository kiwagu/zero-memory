'use client';

import * as React from 'react';
import { Scale, Trash2 } from 'lucide-react';

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
import { Switch } from '@workspace/ui/components/switch';

export type JudgeProviderName = 'typesafe' | 'subq';

export interface JudgeProviderLabels {
  title: string;
  description: string;
  enable: string;
  provider: string;
  /** Template with {provider}: the instance's default provider. */
  providerDefault: string;
  key: string;
  keyPlaceholder: string;
  model: string;
  modelPlaceholder: string;
  save: string;
  saving: string;
  /** Template with {provider} and {hint}. */
  installed: string;
  revoke: string;
  revoking: string;
  statusPlatform: string;
  statusOff: string;
  hint: string;
}

export interface JudgeProviderState {
  enabled: boolean;
  /** The account's choice; null leaves it to the instance default. */
  provider: JudgeProviderName | null;
  platformDefault: JudgeProviderName;
  /** The account's own key, described without the key; null when none. */
  credential: { provider: string; hint: string; model: string | null } | null;
  /** Whether this build can run SubQ Snap at all. */
  subqAvailable: boolean;
}

type Result = { ok: true } | { ok: false; error: string };

export type JudgeProviderPanelProps = {
  labels: JudgeProviderLabels;
  current: JudgeProviderState;
  onSettings: (input: {
    enabled: boolean;
    provider: JudgeProviderName | null;
  }) => Promise<Result>;
  onSaveKey: (input: {
    provider: JudgeProviderName;
    apiKey: string;
    model: string | null;
  }) => Promise<Result>;
  onRevokeKey: () => Promise<Result>;
};

/** Product names, the same in every locale. */
const PROVIDER_NAMES: Record<JudgeProviderName, string> = {
  typesafe: 'TypeSafe Jev',
  subq: 'SubQ Snap',
};

const providerName = (provider: string): string =>
  PROVIDER_NAMES[provider as JudgeProviderName] ?? provider;

/** The select's value for "leave it to the instance default". */
const INSTANCE_DEFAULT = '';

const SELECT_CLASS =
  'border-input bg-background h-9 w-full rounded-md border px-3 text-sm';

/**
 * JudgeProviderPanel — whether a decision model picks the delivery level of
 * the account's standing rules, on which provider, and on whose key.
 *
 * Built like the provider-key panel: the key field is write-only, and a stored
 * key is described by its provider and last four characters, never rendered
 * back. The switch and the provider choice save the moment they change.
 */
export function JudgeProviderPanel({
  labels,
  current,
  onSettings,
  onSaveKey,
  onRevokeKey,
}: JudgeProviderPanelProps) {
  const providers: JudgeProviderName[] = current.subqAvailable
    ? ['typesafe', 'subq']
    : ['typesafe'];
  const offered = (provider: string | null | undefined) =>
    providers.find((option) => option === provider);

  const [enabled, setEnabled] = React.useState(current.enabled);
  const [provider, setProvider] = React.useState(current.provider);
  const [installed, setInstalled] = React.useState(current.credential);
  const [keyProvider, setKeyProvider] = React.useState<JudgeProviderName>(
    offered(current.credential?.provider) ??
      offered(current.provider) ??
      offered(current.platformDefault) ??
      'typesafe'
  );
  const [apiKey, setApiKey] = React.useState('');
  const [model, setModel] = React.useState(current.credential?.model ?? '');
  const [busy, setBusy] = React.useState<'settings' | 'save' | 'revoke' | null>(
    null
  );
  const [error, setError] = React.useState<string | null>(null);

  const saveSettings = async (next: {
    enabled: boolean;
    provider: JudgeProviderName | null;
  }) => {
    setBusy('settings');
    setError(null);
    const result = await onSettings(next);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEnabled(next.enabled);
    setProvider(next.provider);
  };

  const saveKey = async () => {
    setBusy('save');
    setError(null);
    const result = await onSaveKey({
      provider: keyProvider,
      apiKey,
      model: model === '' ? null : model,
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Installing a key also chooses its provider, so the two never disagree.
    // The field is cleared the moment the key is accepted: a stored key has
    // no reason to stay in the page.
    setInstalled({
      provider: keyProvider,
      hint: apiKey.slice(-4),
      model: model === '' ? null : model,
    });
    setProvider(keyProvider);
    setApiKey('');
  };

  const revokeKey = async () => {
    setBusy('revoke');
    setError(null);
    const result = await onRevokeKey();
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setInstalled(null);
    setApiKey('');
  };

  // With a key installed and judging on, the installed line is the status.
  const status = !enabled
    ? labels.statusOff
    : installed
      ? null
      : labels.statusPlatform;

  return (
    <Card data-testid="settings-judge-provider">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale className="size-4" /> {labels.title}
        </CardTitle>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex cursor-pointer items-center gap-3 text-sm">
            <Switch
              data-testid="settings-judge-enable"
              checked={enabled}
              disabled={busy !== null}
              onCheckedChange={(checked) =>
                void saveSettings({ enabled: checked, provider })
              }
            />
            {labels.enable}
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="judge-provider">{labels.provider}</Label>
            <select
              id="judge-provider"
              className={SELECT_CLASS}
              value={provider ?? INSTANCE_DEFAULT}
              // An own key decides the provider while it is installed.
              disabled={busy !== null || installed !== null}
              onChange={(event) =>
                void saveSettings({
                  enabled,
                  provider: offered(event.target.value) ?? null,
                })
              }
              data-testid="settings-judge-provider-select"
            >
              <option value={INSTANCE_DEFAULT}>
                {labels.providerDefault.replace(
                  '{provider}',
                  providerName(current.platformDefault)
                )}
              </option>
              {providers.map((option) => (
                <option key={option} value={option}>
                  {PROVIDER_NAMES[option]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {status ? (
          <p
            className="text-muted-foreground text-sm"
            data-testid="settings-judge-status"
          >
            {status}
          </p>
        ) : null}

        {installed ? (
          <Alert data-testid="settings-judge-installed">
            <AlertDescription className="flex items-center justify-between gap-3">
              <span>
                {labels.installed
                  .replace('{provider}', providerName(installed.provider))
                  .replace('{hint}', installed.hint)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void revokeKey()}
                data-testid="settings-judge-revoke"
              >
                <Trash2 className="size-4" />
                {busy === 'revoke' ? labels.revoking : labels.revoke}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="judge-key-provider">{labels.provider}</Label>
            <select
              id="judge-key-provider"
              className={SELECT_CLASS}
              value={keyProvider}
              onChange={(event) =>
                setKeyProvider(offered(event.target.value) ?? 'typesafe')
              }
              data-testid="settings-judge-key-provider"
            >
              {providers.map((option) => (
                <option key={option} value={option}>
                  {PROVIDER_NAMES[option]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="judge-model">{labels.model}</Label>
            <Input
              id="judge-model"
              value={model}
              placeholder={labels.modelPlaceholder}
              onChange={(event) => setModel(event.target.value)}
              data-testid="settings-judge-model"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="judge-key-value">{labels.key}</Label>
          <Input
            id="judge-key-value"
            // A password field: masked, kept out of autofill history and not
            // read aloud by assistive tech.
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            placeholder={labels.keyPlaceholder}
            onChange={(event) => setApiKey(event.target.value)}
            data-testid="settings-judge-key-input"
          />
        </div>

        {error ? (
          <Alert variant="destructive" data-testid="settings-judge-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">{labels.hint}</p>
          <Button
            disabled={busy !== null || apiKey.trim() === ''}
            onClick={() => void saveKey()}
            data-testid="settings-judge-save"
          >
            {busy === 'save' ? labels.saving : labels.save}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
