'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  AcceptTermsCard,
  type AcceptTermsLabels,
} from '@workspace/ui/components/auth/accept-terms-card';
import type { ConsentCopy } from '@workspace/ui/components/auth/consent-sentence';

import { createClient } from '@/lib/supabase/client';
import { acceptTerms } from '@/lib/terms.actions';

/**
 * Client wrapper: the card is presentation, the server action records the
 * acceptance and redirects. A successful action never returns — Next performs
 * the redirect it threw — so `pending` stays on until the page changes.
 */
export function AcceptTermsView({
  next,
  labels,
  consent,
}: {
  next: string;
  labels: AcceptTermsLabels;
  consent: ConsentCopy;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAccept() {
    setPending(true);
    setError(null);
    const result = await acceptTerms(next);
    // Only a failure comes back; success redirected already.
    setError(result.error);
    setPending(false);
  }

  async function handleSignOut() {
    setPending(true);
    // Local scope, as the dashboard's own sign-out: this browser leaves,
    // agents authorized elsewhere keep their sessions.
    await createClient().auth.signOut({ scope: 'local' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <AcceptTermsCard
      labels={labels}
      consent={consent}
      checked={checked}
      pending={pending}
      error={error}
      onCheckedChange={setChecked}
      onAccept={() => void handleAccept()}
      onSignOut={() => void handleSignOut()}
    />
  );
}
