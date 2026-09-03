'use client';

import Link from 'next/link';
import { useState } from 'react';

import {
  ForgotPasswordForm,
  type ForgotPasswordFormLabels,
} from '@workspace/ui/components/auth/forgot-password-form';
import {
  MailSentNotice,
  type MailSentNoticeLabels,
} from '@workspace/ui/components/auth/mail-sent-notice';

import { createClient } from '@/lib/supabase/client';

export function ForgotPasswordView({
  labels,
  sentLabels,
}: {
  labels: ForgotPasswordFormLabels;
  /** Copy for the "we emailed you" screen; `{email}` is filled in here. */
  sentLabels: Omit<MailSentNoticeLabels, 'description'> & {
    descriptionTemplate: string;
  };
}) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The address the reset was requested for. Non-null IS the state "the mail is
  // out": it decides which screen is shown, the same way the sign-up path does,
  // so both flows end on one shape instead of two.
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [pending, setPending] = useState(false);

  async function requestReset(address: string): Promise<boolean> {
    setPending(true);
    setError(null);
    const supabase = createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      address,
      {
        // Straight to the landing page, not through the server callback: a
        // recovery redirect can carry its tokens in the URL FRAGMENT, which
        // a browser never sends to a server route, so the callback would see
        // an empty request and bounce. The page below handles both shapes.
        redirectTo: `${window.location.origin}/reset-password`,
      }
    );
    setPending(false);
    if (resetError) {
      setError(resetError.message);
      return false;
    }
    return true;
  }

  async function handleSubmit() {
    if (await requestReset(email)) {
      setSentTo(email);
    }
  }

  async function handleResend() {
    if (sentTo && (await requestReset(sentTo))) {
      setResent(true);
    }
  }

  if (sentTo) {
    const { descriptionTemplate, ...rest } = sentLabels;
    return (
      <MailSentNotice
        testIdPrefix="auth-forgot-sent"
        labels={{
          ...rest,
          description: descriptionTemplate.replace('{email}', sentTo),
        }}
        resent={resent}
        pending={pending}
        error={error}
        onResend={() => void handleResend()}
        onBackToSignIn={() => {
          setSentTo(null);
          setResent(false);
          setError(null);
        }}
      />
    );
  }

  return (
    <ForgotPasswordForm
      labels={labels}
      email={email}
      error={error}
      pending={pending}
      onEmailChange={setEmail}
      onSubmit={() => void handleSubmit()}
      signInHref="/login"
      linkComponent={Link}
    />
  );
}
