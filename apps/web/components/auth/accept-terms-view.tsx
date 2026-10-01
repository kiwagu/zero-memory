'use client';

import { useState } from 'react';

import {
  AcceptTermsCard,
  type AcceptTermsLabels,
} from '@workspace/ui/components/auth/accept-terms-card';
import type { ConsentCopy } from '@workspace/ui/components/auth/consent-sentence';

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

  return (
    <AcceptTermsCard
      labels={labels}
      consent={consent}
      checked={checked}
      pending={pending}
      error={error}
      onCheckedChange={setChecked}
      onAccept={() => void handleAccept()}
    />
  );
}
