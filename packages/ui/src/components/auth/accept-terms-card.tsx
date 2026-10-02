'use client';

import { Button } from '@workspace/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import { Field, FieldLabel } from '@workspace/ui/components/field';
import {
  ConsentSentence,
  type ConsentCopy,
} from '@workspace/ui/components/auth/consent-sentence';

interface AcceptTermsLabels {
  title: string;
  description: string;
  continue: string;
  continuePending: string;
  /** The way out for someone who declines, or picked the wrong account. */
  signOut: string;
}

/**
 * AcceptTermsCard — the one-time acceptance an account created by a provider
 * owes on an instance that publishes documents. Mechanism only: copy arrives
 * translated, the submission is the injected `onAccept`. The checkbox is
 * `required`, so the browser refuses an unticked submission by itself.
 */
function AcceptTermsCard({
  labels,
  consent,
  checked,
  pending,
  error,
  onCheckedChange,
  onAccept,
  onSignOut,
}: {
  labels: AcceptTermsLabels;
  consent: ConsentCopy;
  checked: boolean;
  pending: boolean;
  error: string | null;
  onCheckedChange: (checked: boolean) => void;
  onAccept: () => void;
  onSignOut: () => void;
}) {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          data-testid="accept-terms-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onAccept();
          }}
        >
          <Field orientation="horizontal">
            <input
              id="accept-terms-consent"
              data-testid="accept-terms-consent"
              type="checkbox"
              required
              checked={checked}
              onChange={(event) => onCheckedChange(event.target.checked)}
              className="border-input accent-primary mt-0.5 size-4 shrink-0 rounded"
            />
            <FieldLabel
              htmlFor="accept-terms-consent"
              className="text-muted-foreground text-sm font-normal"
            >
              <ConsentSentence consent={consent} />
            </FieldLabel>
          </Field>
          {error ? (
            <p
              data-testid="accept-terms-error"
              className="text-destructive text-sm"
            >
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            data-testid="accept-terms-submit"
            disabled={pending}
            className="w-full"
          >
            {pending ? labels.continuePending : labels.continue}
          </Button>
          <p className="text-center text-sm">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="text-muted-foreground h-auto p-0"
              data-testid="accept-terms-sign-out"
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

export { AcceptTermsCard, type AcceptTermsLabels };
