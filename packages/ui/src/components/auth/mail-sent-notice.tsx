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

/**
 * MailSentNotice — the screen every "we just emailed you" moment lands on: the
 * request succeeded, nothing more can happen in this tab, and the only next
 * action is in the reader's inbox. Used after sign-up and after a password
 * reset request.
 *
 * It REPLACES the form rather than annotating it. A one-line notice under a
 * form that is still standing reads as "nothing happened": the fields are there,
 * still inviting a submit, so the person submits again instead of opening their
 * mail. A screen that says what was sent and to which address leaves exactly one
 * next action.
 *
 * Mechanism only: copy arrives translated, resending is the injected callback.
 */

interface MailSentNoticeLabels {
  title: string;
  /** Already interpolated with the address the link went to. */
  description: string;
  hint: string;
  resend: string;
  resendPending: string;
  resent: string;
  backToSignIn: string;
}

interface MailSentNoticeProps {
  labels: MailSentNoticeLabels;
  /** True once a resend has succeeded — the button says so and stands down. */
  resent: boolean;
  pending: boolean;
  error: string | null;
  onResend: () => void;
  onBackToSignIn: () => void;
  /**
   * Names this instance's elements (`<prefix>`, `-description`, `-error`,
   * `-resend`, `-back`). Two flows render this screen; a shared id would make a
   * test unable to say which one it is looking at.
   */
  testIdPrefix: string;
}

function MailSentNotice({
  labels,
  resent,
  pending,
  error,
  onResend,
  onBackToSignIn,
  testIdPrefix,
}: MailSentNoticeProps) {
  return (
    <Card className="w-full max-w-sm" data-testid={testIdPrefix}>
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        <CardDescription data-testid={`${testIdPrefix}-description`}>
          {labels.description}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">{labels.hint}</p>
        {error ? (
          <p
            className="text-destructive text-sm"
            data-testid={`${testIdPrefix}-error`}
          >
            {error}
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={pending || resent}
          onClick={onResend}
          data-testid={`${testIdPrefix}-resend`}
        >
          {pending
            ? labels.resendPending
            : resent
              ? labels.resent
              : labels.resend}
        </Button>
        <p className="text-center text-sm">
          <button
            type="button"
            onClick={onBackToSignIn}
            className="text-muted-foreground hover:text-foreground underline"
            data-testid={`${testIdPrefix}-back`}
          >
            {labels.backToSignIn}
          </button>
        </p>
      </CardContent>
    </Card>
  );
}

export { MailSentNotice, type MailSentNoticeLabels, type MailSentNoticeProps };
