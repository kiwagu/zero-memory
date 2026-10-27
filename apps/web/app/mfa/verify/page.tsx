import { redirect } from 'next/navigation';

import { BuildVersion } from '@/components/build-version';
import { MfaVerifyView } from '@/components/auth/mfa-verify-view';
import { getRequestMessages } from '@/lib/i18n';
import { assuranceGap, readAssurance } from '@/lib/mfa';
import { safeNext } from '@/lib/safe-next';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * The second-factor step. Pages behind the factor send a session here when
 * it has not presented the code yet, with the page to return to as `next`.
 * A session that owes nothing — no factor, or the code already given — goes
 * straight on, so this page is never a dead end and never asks twice.
 */
export default async function MfaVerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams).next);
  const supabase = await createServerSupabaseClient();
  const { aal, verifiedFactors } = await readAssurance(supabase);
  if (assuranceGap(aal, verifiedFactors) === 'none') {
    redirect(next);
  }
  const { t } = await getRequestMessages();

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <MfaVerifyView
        next={next}
        labels={{
          title: t('auth.mfa.title'),
          description: t('auth.mfa.description'),
          code: t('auth.mfa.code'),
          signOut: t('auth.mfa.signOut'),
        }}
        messages={{
          refused: t('auth.mfa.refused'),
          failed: t('auth.mfa.failed'),
        }}
      />
      <div className="fixed inset-x-0 bottom-3 text-center">
        <BuildVersion />
      </div>
    </main>
  );
}
