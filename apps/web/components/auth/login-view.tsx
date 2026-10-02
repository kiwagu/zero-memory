'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  LoginForm,
  type LoginFormLabels,
  type LoginMode,
} from '@workspace/ui/components/auth/login-form';
import {
  MailSentNotice,
  type MailSentNoticeLabels,
} from '@workspace/ui/components/auth/mail-sent-notice';

import type { SocialProvider } from '@/lib/auth-providers';
import { createClient } from '@/lib/supabase/client';
import type { LegalLinks } from '@/lib/legal';

export function LoginView({
  initialError,
  next,
  providers,
  providerLabels,
  labels,
  confirmationLabels,
  legal,
  consentLabels,
}: {
  /** Reason a redirect landed here, e.g. a callback that could not complete. */
  initialError?: string;
  /** Where to go after sign-in; already cleaned by the page. */
  next: string;
  /** The social providers this instance enables, in display order. */
  providers: SocialProvider[];
  providerLabels: {
    github: string;
    google: string;
    or: string;
    linkedHint: string;
  };
  labels: LoginFormLabels;
  /** Resolved from this deployment's configuration; absent documents = no gate. */
  legal: LegalLinks;
  /** Consent copy, already translated; `{terms}`/`{privacy}` mark the links. */
  consentLabels: {
    template: string;
    termsLabel: string;
    privacyLabel: string;
  };
  /** Copy for the post-sign-up screen; `{email}` is filled in here. */
  confirmationLabels: Omit<MailSentNoticeLabels, 'description'> & {
    descriptionTemplate: string;
  };
}) {
  const router = useRouter();
  const [mode, setMode] = useState<LoginMode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  // The address a confirmation link went to. Non-null IS the state "waiting for
  // the inbox": it decides which screen is shown, so the two cannot disagree.
  const [awaitingConfirmation, setAwaitingConfirmation] = useState<
    string | null
  >(null);
  const [resent, setResent] = useState(false);

  // Auth puts a refusal in the URL FRAGMENT when there is no code to exchange
  // — a spent or expired link, an implicit-flow error. The server never sees
  // a fragment, so only the browser can turn it into the message it is.
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) {
      return;
    }
    const params = new URLSearchParams(hash);
    const reason = params.get('error_description') ?? params.get('error');
    if (!reason) {
      return;
    }
    // Deferred, as the reset view does: a state write that is part of the
    // effect's own tick would re-render in the same pass it synchronises.
    const timer = setTimeout(() => {
      setError(reason);
      window.history.replaceState(null, '', window.location.pathname);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  function switchMode(next: LoginMode) {
    setMode(next);
    setError(null);
    setNotice(null);
    // Leaving sign-up drops the acceptance: coming back has to be a fresh,
    // deliberate tick rather than a box someone finds already ticked.
    setConsentAccepted(false);
  }

  function backToSignIn() {
    setAwaitingConfirmation(null);
    setResent(false);
    setPassword('');
    setMode('sign-in');
    setError(null);
    setNotice(null);
  }

  async function handleSubmit() {
    setPending(true);
    setError(null);
    setNotice(null);
    const supabase = createClient();

    if (mode === 'sign-up') {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          // Recorded with the account, because an acceptance nobody can
          // evidence later is the same as none: WHEN it happened, and WHICH
          // text it was, when the deployment labels its version.
          ...(legal.required
            ? {
                data: {
                  terms_accepted_at: new Date().toISOString(),
                  ...(legal.version
                    ? { terms_version: legal.version }
                    : undefined),
                },
              }
            : undefined),
        },
      });
      if (signUpError) {
        setError(signUpError.message);
        setPending(false);
        return;
      }
      // With email confirmation enabled the server returns no session yet: the
      // account exists but nothing more can happen in this tab. Hand the person
      // a screen about their inbox instead of a form that looks untouched.
      if (!data.session) {
        setAwaitingConfirmation(email);
        setPending(false);
        return;
      }
      router.replace(next);
      router.refresh();
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) {
      setError(signInError.message);
      setPending(false);
      return;
    }
    router.replace(next);
    router.refresh();
  }

  async function handleProvider(provider: SocialProvider) {
    setPending(true);
    setError(null);
    setNotice(null);
    const supabase = createClient();
    // The provider sends the browser to Auth, Auth to /auth/callback with a
    // code, and the callback — after exchanging it — to `next`. The callback
    // cleans `next` again: it travels through two other sites on the way.
    const { error: providerError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (providerError) {
      setError(providerError.message);
      setPending(false);
    }
    // On success the browser is already navigating away; nothing to reset.
  }

  async function handleResend() {
    if (!awaitingConfirmation) {
      return;
    }
    setPending(true);
    setError(null);
    const supabase = createClient();
    const { error: resendError } = await supabase.auth.resend({
      type: 'signup',
      email: awaitingConfirmation,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    setPending(false);
    if (resendError) {
      setError(resendError.message);
      return;
    }
    setResent(true);
  }

  if (awaitingConfirmation) {
    const { descriptionTemplate, ...rest } = confirmationLabels;
    return (
      <MailSentNotice
        testIdPrefix="auth-signup-confirmation"
        labels={{
          ...rest,
          description: descriptionTemplate.replace(
            '{email}',
            awaitingConfirmation
          ),
        }}
        resent={resent}
        pending={pending}
        error={error}
        onResend={() => void handleResend()}
        onBackToSignIn={backToSignIn}
      />
    );
  }

  return (
    <LoginForm
      labels={labels}
      mode={mode}
      email={email}
      password={password}
      error={error}
      notice={notice}
      pending={pending}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onModeChange={switchMode}
      onSubmit={() => void handleSubmit()}
      forgotPasswordHref="/forgot-password"
      providers={
        providers.length > 0
          ? {
              items: providers.map((id) => ({
                id,
                label: providerLabels[id],
              })),
              dividerLabel: providerLabels.or,
              linkedHint: providerLabels.linkedHint,
              onSelect: (id) => void handleProvider(id),
            }
          : undefined
      }
      consent={
        legal.required
          ? {
              ...consentLabels,
              termsHref: legal.termsUrl,
              privacyHref: legal.privacyUrl,
              checked: consentAccepted,
              onCheckedChange: setConsentAccepted,
            }
          : undefined
      }
      linkComponent={Link}
    />
  );
}
