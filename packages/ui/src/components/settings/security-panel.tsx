'use client';

import * as React from 'react';

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

export interface SecurityLabels {
  title: string;
  description: string;
  start: string;
  scanHint: string;
  secretHint: string;
  code: string;
  confirm: string;
  confirming: string;
  cancel: string;
  enabled: string;
  /** `{date}` is replaced with when the app was added. */
  addedOn: string;
  remove: string;
  /** Shown when removing needs the code first. */
  removeNeedsCode: string;
}

export interface SecurityFactor {
  id: string;
  friendlyName: string;
  createdAt: string;
}

export type SecurityState =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'enrolling'; factorId: string; qrCode: string; secret: string }
  | {
      kind: 'enabled';
      factors: SecurityFactor[];
      /** Removing a factor needs a session that gave the code (aal2). */
      canRemove: boolean;
    };

export type SecurityPanelProps = {
  labels: SecurityLabels;
  state: SecurityState;
  pending: boolean;
  error: string | null;
  onStart: () => void;
  onConfirm: (code: string) => void;
  onCancel: () => void;
  onRemove: (factorId: string) => void;
};

/**
 * Two-factor authentication for the account: an authenticator app, turned on
 * by scanning a code and confirming one six-digit code from it, and removed
 * only by a session that has given the code. Mechanism only: the wrapper owns
 * the Auth calls and the copy arrives translated.
 */
function SecurityPanel({
  labels,
  state,
  pending,
  error,
  onStart,
  onConfirm,
  onCancel,
  onRemove,
}: SecurityPanelProps) {
  const [code, setCode] = React.useState('');

  return (
    <Card data-testid="settings-security">
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {state.kind === 'none' ? (
          <Button
            type="button"
            className="self-start"
            data-testid="mfa-start"
            disabled={pending}
            onClick={onStart}
          >
            {labels.start}
          </Button>
        ) : null}

        {state.kind === 'enrolling' ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              onConfirm(code);
            }}
          >
            <p className="text-sm">{labels.scanHint}</p>
            {/* Auth hands the code over as an SVG data URL. */}
            <img
              src={state.qrCode}
              alt=""
              data-testid="mfa-qr"
              className="size-44 rounded-md bg-white p-2"
            />
            <p className="text-muted-foreground text-sm">
              {labels.secretHint}{' '}
              <code
                data-testid="mfa-secret"
                className="text-foreground font-mono break-all"
              >
                {state.secret}
              </code>
            </p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="mfa-code">{labels.code}</Label>
              <Input
                id="mfa-code"
                data-testid="mfa-code"
                value={code}
                onChange={(event) =>
                  setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                }
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="max-w-40"
                required
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="submit"
                data-testid="mfa-confirm"
                disabled={pending || code.length !== 6}
              >
                {pending ? labels.confirming : labels.confirm}
              </Button>
              <Button
                type="button"
                variant="outline"
                data-testid="mfa-cancel"
                disabled={pending}
                onClick={onCancel}
              >
                {labels.cancel}
              </Button>
            </div>
          </form>
        ) : null}

        {state.kind === 'enabled' ? (
          <div className="flex flex-col gap-3" data-testid="mfa-enabled">
            <p className="text-sm font-medium">{labels.enabled}</p>
            <ul className="flex flex-col gap-2">
              {state.factors.map((factor) => (
                <li
                  key={factor.id}
                  className="flex items-center justify-between gap-4 rounded-md border p-3 text-sm"
                >
                  <span>
                    <span className="block">{factor.friendlyName}</span>
                    <span className="text-muted-foreground block">
                      {labels.addedOn.replace(
                        '{date}',
                        factor.createdAt.slice(0, 10)
                      )}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="mfa-remove"
                    disabled={pending}
                    onClick={() => onRemove(factor.id)}
                  >
                    {labels.remove}
                  </Button>
                </li>
              ))}
            </ul>
            {state.canRemove ? null : (
              <p className="text-muted-foreground text-sm">
                {labels.removeNeedsCode}
              </p>
            )}
          </div>
        ) : null}

        {error ? (
          <p
            data-testid="mfa-error"
            role="alert"
            className="text-destructive text-sm"
          >
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export { SecurityPanel };
