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
import { Field, FieldLabel } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';

interface MfaVerifyLabels {
  title: string;
  description: string;
  code: string;
  verify: string;
  verifying: string;
  /** The way out for someone who cannot produce the code. */
  signOut: string;
}

/**
 * MfaVerifyCard — the second-factor step: six digits from the person's
 * authenticator app. Mechanism only: copy arrives translated, the check and
 * the way out are injected. The field clears itself when a code is refused,
 * so the next attempt starts empty.
 */
function MfaVerifyCard({
  labels,
  pending,
  error,
  onSubmit,
  onSignOut,
}: {
  labels: MfaVerifyLabels;
  pending: boolean;
  error: string | null;
  onSubmit: (code: string) => void;
  onSignOut: () => void;
}) {
  const [code, setCode] = React.useState('');
  const [shownError, setShownError] = React.useState(error);
  if (error !== shownError) {
    setShownError(error);
    if (error) {
      setCode('');
    }
  }
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          data-testid="mfa-verify-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(code);
          }}
        >
          <Field>
            <FieldLabel htmlFor="mfa-verify-code">{labels.code}</FieldLabel>
            <Input
              id="mfa-verify-code"
              data-testid="mfa-verify-code"
              value={code}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
              }
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
            />
          </Field>
          {error ? (
            <p
              data-testid="mfa-verify-error"
              role="alert"
              className="text-destructive text-sm"
            >
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            data-testid="mfa-verify-submit"
            disabled={pending || code.length !== 6}
            className="w-full"
          >
            {pending ? labels.verifying : labels.verify}
          </Button>
          <p className="text-center text-sm">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="text-muted-foreground h-auto p-0"
              data-testid="mfa-verify-sign-out"
              disabled={pending}
              onClick={onSignOut}
            >
              {labels.signOut}
            </Button>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

export { MfaVerifyCard, type MfaVerifyLabels };
