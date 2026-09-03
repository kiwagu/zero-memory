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

/**
 * ForgotPasswordForm — the "email me a reset link" card. Mechanism only:
 * copy arrives translated, the reset request is the injected `onSubmit`.
 *
 * It has no "sent" state on purpose: once the mail is out this form is replaced
 * by `MailSentNotice`, so the request and its outcome are never two readings of
 * the same screen.
 */

interface ForgotPasswordFormLabels {
  title: string;
  description: string;
  email: string;
  submit: string;
  submitPending: string;
  backToSignIn: string;
}

interface ForgotPasswordFormProps {
  labels: ForgotPasswordFormLabels;
  email: string;
  error: string | null;
  pending: boolean;
  onEmailChange: (value: string) => void;
  onSubmit: () => void;
  signInHref: string;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}

function ForgotPasswordForm({
  labels,
  email,
  error,
  pending,
  onEmailChange,
  onSubmit,
  signInHref,
  linkComponent: LinkComponent = 'a',
}: ForgotPasswordFormProps) {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
          className="space-y-4"
          data-testid="auth-forgot-form"
        >
          <Field>
            <FieldLabel htmlFor="forgot-email">{labels.email}</FieldLabel>
            <Input
              id="forgot-email"
              data-testid="auth-forgot-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
            />
          </Field>
          {error ? (
            <p
              className="text-sm text-destructive"
              data-testid="auth-forgot-error"
            >
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={pending}
            className="w-full"
            data-testid="auth-forgot-submit"
          >
            {pending ? labels.submitPending : labels.submit}
          </Button>
          <p className="text-center text-sm">
            <LinkComponent
              href={signInHref}
              className="text-muted-foreground underline hover:text-foreground"
            >
              {labels.backToSignIn}
            </LinkComponent>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

export {
  ForgotPasswordForm,
  type ForgotPasswordFormLabels,
  type ForgotPasswordFormProps,
};
