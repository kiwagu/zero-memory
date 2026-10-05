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
import {
  TOTP_CODE_LENGTH,
  TotpCodeField,
} from '@workspace/ui/components/auth/totp-code-field';

interface MfaVerifyLabels {
  title: string;
  description: string;
  /** The field's name for screen readers; no visible label repeats it. */
  code: string;
  /** The way out for someone who cannot produce the code. */
  signOut: string;
}

/**
 * MfaVerifyCard — the second-factor step: six digits from the person's
 * authenticator app, centred, sent by themselves when the last one lands (or
 * on Enter once all six are in) — there is no button to press. While the code
 * is checked the cells are dimmed and locked. Mechanism only: copy arrives
 * translated, the check and the way out are injected. A refused code clears
 * the cells and puts focus back on the first, and the message goes away as
 * soon as the next code is being typed.
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
            // Enter sends a complete code; an incomplete one waits for more.
            if (!pending && code.length === TOTP_CODE_LENGTH) {
              onSubmit(code);
            }
          }}
        >
          <div className="flex justify-center">
            <TotpCodeField
              id="mfa-verify-code"
              ariaLabel={labels.code}
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
          </div>
          {visibleError ? (
            <p
              data-testid="mfa-verify-error"
              role="alert"
              className="text-destructive text-center text-sm"
            >
              {visibleError}
            </p>
          ) : null}
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
