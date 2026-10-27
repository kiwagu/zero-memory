'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  OAuthConsentCard,
  type OAuthConsentLabels,
} from '@workspace/ui/components/auth/oauth-consent-card';

import { decideConsent } from '@/lib/oauth-consent.actions';
import { createClient } from '@/lib/supabase/client';

/**
 * Client wrapper: the card is presentation, the server action carries the
 * decision. On an answer the browser leaves for the client's redirect URI —
 * a full navigation, because it may be a loopback port or an app's own scheme
 * — so `pending` stays on until the page is gone.
 */
export function OAuthConsentView({
  authorizationId,
  clientName,
  returnHost,
  account,
  labels,
  messages,
}: {
  authorizationId: string;
  clientName: string | null;
  returnHost: string;
  account: string;
  labels: OAuthConsentLabels;
  messages: { gone: string; failed: string };
}) {
  const router = useRouter();
  const [pending, setPending] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'deny') {
    setPending(decision === 'approve' ? 'allow' : 'deny');
    setError(null);
    const result = await decideConsent(authorizationId, decision);
    if (result.kind === 'redirect') {
      window.location.assign(result.url);
      return;
    }
    setError(result.kind === 'gone' ? messages.gone : messages.failed);
    setPending(null);
  }

  async function signOut() {
    setPending('deny');
    // Local scope, as the dashboard's own sign-out: this browser leaves,
    // agents authorized elsewhere keep their sessions. The request stays
    // bound to this account, so another account starts over from the client.
    await createClient().auth.signOut({ scope: 'local' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <OAuthConsentCard
      labels={labels}
      clientName={clientName}
      returnHost={returnHost}
      account={account}
      pending={pending}
      error={error}
      onAllow={() => void decide('approve')}
      onDeny={() => void decide('deny')}
      onSignOut={() => void signOut()}
    />
  );
}
