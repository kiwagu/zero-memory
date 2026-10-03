'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  MfaVerifyCard,
  type MfaVerifyLabels,
} from '@workspace/ui/components/auth/mfa-verify-card';

import { createClient } from '@/lib/supabase/client';

/**
 * Client wrapper for the second-factor step: the code is checked against the
 * account's verified authenticator, which raises this session to `aal2`, and
 * the page the person was going to opens. A refused code leaves them here
 * with an empty field.
 */
export function MfaVerifyView({
  next,
  labels,
  messages,
}: {
  next: string;
  labels: MfaVerifyLabels;
  messages: { refused: string; failed: string };
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify(code: string) {
    setPending(true);
    setError(null);
    const supabase = createClient();
    const { data: factors, error: listError } =
      await supabase.auth.mfa.listFactors();
    const factor = factors?.totp.find((item) => item.status === 'verified');
    if (listError || !factor) {
      setError(messages.failed);
      setPending(false);
      return;
    }
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code,
    });
    if (verifyError) {
      setError(messages.refused);
      setPending(false);
      return;
    }
    router.replace(next);
    router.refresh();
  }

  async function signOut() {
    setPending(true);
    // Local scope, as everywhere in the dashboard: this browser leaves,
    // agents keep their own sessions.
    await createClient().auth.signOut({ scope: 'local' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <MfaVerifyCard
      labels={labels}
      pending={pending}
      error={error}
      onSubmit={(code) => void verify(code)}
      onSignOut={() => void signOut()}
    />
  );
}
