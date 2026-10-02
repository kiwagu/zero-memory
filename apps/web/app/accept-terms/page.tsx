import { redirect } from 'next/navigation';

import { BuildVersion } from '@/components/build-version';
import { AcceptTermsView } from '@/components/auth/accept-terms-view';
import { getRequestMessages } from '@/lib/i18n';
import { legalLinks } from '@/lib/legal';
import { safeNext } from '@/lib/safe-next';

/**
 * The one-time acceptance for an account that arrived without one — created
 * through a provider, or before the instance published its documents. The
 * dashboard layout sends such accounts here; an instance with no documents
 * has nothing to accept, so a direct visit there goes straight to the feed.
 */
export default async function AcceptTermsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const legal = legalLinks();
  if (!legal.required) {
    redirect('/');
  }
  const { t } = await getRequestMessages();
  const next = safeNext((await searchParams).next);
  const template =
    legal.documents === 'both'
      ? t('auth.consent.template', { terms: '{terms}', privacy: '{privacy}' })
      : legal.documents === 'terms'
        ? t('auth.consent.templateTerms', { terms: '{terms}' })
        : t('auth.consent.templatePrivacy', { privacy: '{privacy}' });

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <AcceptTermsView
        next={next}
        labels={{
          title: t('auth.acceptTerms.title'),
          description: t('auth.acceptTerms.description'),
          continue: t('auth.acceptTerms.continue'),
          continuePending: t('auth.acceptTerms.continuePending'),
          signOut: t('header.signOut'),
        }}
        consent={{
          template,
          termsLabel: t('auth.consent.terms'),
          privacyLabel: t('auth.consent.privacy'),
          termsHref: legal.termsUrl,
          privacyHref: legal.privacyUrl,
        }}
      />
      <div className="fixed inset-x-0 bottom-3 text-center">
        <BuildVersion />
      </div>
    </main>
  );
}
