'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  ResetPasswordForm,
  type ResetPasswordFormLabels,
} from '@workspace/ui/components/auth/reset-password-form';

import { createClient } from '@/lib/supabase/client';

/**
 * Landing page of a recovery link. The link can arrive in either shape — a
 * `?code=` to exchange or tokens in the URL fragment — and the browser client
 * settles both on load, so the form waits for a session instead of assuming
 * one. Without that wait, `updateUser` fires against no session and the reset
 * fails with an error nobody can act on.
 */
export function ResetPasswordView({
  labels,
  mismatchError,
  noSessionError,
}: {
  labels: ResetPasswordFormLabels;
  mismatchError: string;
  noSessionError: string;
}) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  // A link that Auth already refused comes back carrying its reason in the URL
  // fragment. Showing a password form on top of that is worse than useless:
  // nothing typed into it can ever be saved.
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let settled = false;
    const settle = () => {
      settled = true;
      setReady(true);
    };

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session) {
          settle();
        }
      }
    );
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        settle();
      }
    });

    // A link the client cannot turn into a session gives nothing to read: a
    // spent code, or one opened in a browser that never held its verifier,
    // simply never completes its exchange — no error, no event, and a form
    // that would swallow every click. Auth's own refusals arrive in the URL
    // fragment and are recognised immediately; everything else is separated
    // from a merely slow exchange by waiting, then refusing.
    const refused = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const immediate = Boolean(
      refused.get('error') || refused.get('error_code')
    );
    const timer = setTimeout(
      () => {
        if (!settled) {
          setRejected(true);
        }
      },
      immediate ? 0 : 4000
    );

    return () => {
      clearTimeout(timer);
      subscription.subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit() {
    // Unreachable from the UI: the button stays disabled until the exchange
    // settles, which is what keeps a fast click from being told its perfectly
    // good link is dead. Kept as an invariant guard for a programmatic submit.
    if (!ready) {
      setError(noSessionError);
      return;
    }
    if (password !== confirm) {
      setError(mismatchError);
      return;
    }
    setPending(true);
    setError(null);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      setPending(false);
      return;
    }
    router.replace('/');
    router.refresh();
  }

  if (rejected) {
    return (
      <p
        data-testid="auth-reset-rejected"
        className="text-muted-foreground max-w-sm text-center text-sm"
      >
        {noSessionError}
      </p>
    );
  }

  return (
    <ResetPasswordForm
      labels={labels}
      password={password}
      confirm={confirm}
      error={error}
      pending={pending}
      linkPending={!ready}
      onPasswordChange={setPassword}
      onConfirmChange={setConfirm}
      onSubmit={() => void handleSubmit()}
    />
  );
}
