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
import { TotpCodeField } from '@workspace/ui/components/auth/totp-code-field';

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
 * authenticator app, sent by themselves when the last one lands. Mechanism
 * only: copy arrives translated, the check and the way out are injected. A
 * refused code clears the cells and puts focus back on the first, and the
 * message goes away as soon as the next code is being typed.
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
  const [errorDismissed, setErrorDismissed] = React.useState(false);
  if (error !== shownError) {
    setShownError(error);
    setErrorDismissed(false);
    if (error) {
      setCode('');
    }
  }
  const visibleError = errorDismissed ? null : error;
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
            <TotpCodeField
              id="mfa-verify-code"
              testId="mfa-verify-code"
              value={code}
              onChange={(next) => {
                setCode(next);
                if (next !== '') {
                  setErrorDismissed(true);
                }
              }}
              onComplete={onSubmit}
              disabled={pending}
              invalid={visibleError !== null}
              autoFocus
            />
          </Field>
          {visibleError ? (
            <p
              data-testid="mfa-verify-error"
              role="alert"
              className="text-destructive text-sm"
            >
              {visibleError}
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
