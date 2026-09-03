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
 * ResetPasswordForm — the "set a new password" card shown after the recovery
 * link. Mechanism only: copy arrives translated, the update is the injected
 * `onSubmit`.
 */

interface ResetPasswordFormLabels {
  title: string;
  description: string;
  newPassword: string;
  confirmPassword: string;
  submit: string;
  submitPending: string;
}

interface ResetPasswordFormProps {
  labels: ResetPasswordFormLabels;
  password: string;
  confirm: string;
  error: string | null;
  pending: boolean;
  /**
   * The recovery link is still being exchanged for a session. The action is
   * not available yet — and must not be, because a submit landing before the
   * exchange completes has no session to update and would be answered as
   * though the link itself were dead.
   */
  linkPending?: boolean;
  onPasswordChange: (value: string) => void;
  onConfirmChange: (value: string) => void;
  onSubmit: () => void;
}

function ResetPasswordForm({
  labels,
  password,
  confirm,
  error,
  pending,
  linkPending = false,
  onPasswordChange,
  onConfirmChange,
  onSubmit,
}: ResetPasswordFormProps) {
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
          data-testid="auth-reset-form"
        >
          <Field>
            <FieldLabel htmlFor="reset-password">
              {labels.newPassword}
            </FieldLabel>
            <Input
              id="reset-password"
              data-testid="auth-reset-password"
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="reset-confirm">
              {labels.confirmPassword}
            </FieldLabel>
            <Input
              id="reset-confirm"
              data-testid="auth-reset-confirm"
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => onConfirmChange(event.target.value)}
            />
          </Field>
          {error ? (
            <p
              className="text-sm text-destructive"
              data-testid="auth-reset-error"
            >
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={pending || linkPending}
            className="w-full"
            data-testid="auth-reset-submit"
          >
            {pending ? labels.submitPending : labels.submit}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export {
  ResetPasswordForm,
  type ResetPasswordFormLabels,
  type ResetPasswordFormProps,
};
