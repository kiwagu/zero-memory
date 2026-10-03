'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  SecurityPanel,
  type SecurityLabels,
  type SecurityState,
} from '@workspace/ui/components/settings/security-panel';

import { verifyPathFor } from '@/lib/mfa';
import { createClient } from '@/lib/supabase/client';

/**
 * Settings → Security: turning the authenticator app on and off, over the
 * person's own session. Setting up leaves no trace when abandoned: an
 * unconfirmed app is removed on cancel and when the page goes away. Removing
 * a confirmed one needs a session that gave the code, so without it the
 * button leads to the code step first.
 */
export function SettingsSecurity({
  labels,
  messages,
}: {
  labels: SecurityLabels;
  messages: { refused: string; failed: string; appName: string };
}) {
  const router = useRouter();
  const [state, setState] = useState<SecurityState>({ kind: 'loading' });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The unconfirmed factor of a set-up in progress, for the cleanup on leave.
  const pendingFactor = useRef<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [{ data: factors, error: listError }, { data: level }] =
      await Promise.all([
        supabase.auth.mfa.listFactors(),
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      ]);
    if (listError) {
      setError(messages.failed);
      return;
    }
    const verified = (factors?.totp ?? []).filter(
      (factor) => factor.status === 'verified'
    );
    setState(
      verified.length === 0
        ? { kind: 'none' }
        : {
            kind: 'enabled',
            factors: verified.map((factor) => ({
              id: factor.id,
              friendlyName: factor.friendly_name ?? messages.appName,
              createdAt: factor.created_at,
            })),
            canRemove: level?.currentLevel === 'aal2',
          }
    );
  }, [messages.appName, messages.failed]);

  useEffect(() => {
    // Deferred so the first render is not a synchronous state update.
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      const factorId = pendingFactor.current;
      if (factorId) {
        void createClient().auth.mfa.unenroll({ factorId });
      }
    };
  }, [load]);

  async function start() {
    setPending(true);
    setError(null);
    const supabase = createClient();
    // An unconfirmed app left by an earlier, abandoned set-up would block a
    // new one under the same name; clear it first.
    const { data: existing } = await supabase.auth.mfa.listFactors();
    for (const factor of existing?.all ?? []) {
      if (factor.factor_type === 'totp' && factor.status === 'unverified') {
        await supabase.auth.mfa.unenroll({ factorId: factor.id });
      }
    }
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `${messages.appName} ${new Date().toISOString().slice(0, 16)}`,
    });
    setPending(false);
    if (enrollError || !data) {
      setError(messages.failed);
      return;
    }
    pendingFactor.current = data.id;
    setState({
      kind: 'enrolling',
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
    });
  }

  async function confirm(code: string) {
    if (state.kind !== 'enrolling') {
      return;
    }
    setPending(true);
    setError(null);
    const { error: verifyError } =
      await createClient().auth.mfa.challengeAndVerify({
        factorId: state.factorId,
        code,
      });
    setPending(false);
    if (verifyError) {
      setError(messages.refused);
      return;
    }
    pendingFactor.current = null;
    await load();
    // The session now carries the code; server-rendered parts read it again.
    router.refresh();
  }

  async function cancel() {
    if (state.kind !== 'enrolling') {
      return;
    }
    setPending(true);
    const { error: cancelError } = await createClient().auth.mfa.unenroll({
      factorId: state.factorId,
    });
    setPending(false);
    if (cancelError) {
      // The half-set-up app is still there; stay on this step to retry.
      setError(messages.failed);
      return;
    }
    pendingFactor.current = null;
    setError(null);
    setState({ kind: 'none' });
  }

  async function remove(factorId: string) {
    if (state.kind !== 'enabled') {
      return;
    }
    if (!state.canRemove) {
      router.push(verifyPathFor('/settings'));
      return;
    }
    setPending(true);
    setError(null);
    const { error: removeError } = await createClient().auth.mfa.unenroll({
      factorId,
    });
    setPending(false);
    if (removeError) {
      setError(messages.failed);
      return;
    }
    await load();
    router.refresh();
  }

  return (
    <SecurityPanel
      labels={labels}
      state={state}
      pending={pending}
      error={error}
      onStart={() => void start()}
      onConfirm={(code) => void confirm(code)}
      onCancel={() => void cancel()}
      onRemove={(factorId) => void remove(factorId)}
    />
  );
}
