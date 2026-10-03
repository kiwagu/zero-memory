import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';

import { BuildVersion } from '@/components/build-version';
import { OAuthConsentView } from '@/components/auth/oauth-consent-view';
import { getRequestMessages } from '@/lib/i18n';
import { legalLinks } from '@/lib/legal';
import {
  AUTHORIZATION_ID_RE,
  describeScopes,
  readAuthorization,
  returnHost,
} from '@/lib/oauth-consent';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { termsGate } from '@/lib/terms-gate';

/**
 * Where an agent's authorization lands: the server parked the client's
 * request and sent the browser here with its id. The route guard has already
 * made the person sign in, any way the instance offers, and brought them back.
 * A client they approved before is let through without a screen; otherwise
 * they see who is asking, for what, and where the browser returns, and decide.
 */
export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { t } = await getRequestMessages();
  const raw = (await searchParams).authorization_id;
  if (typeof raw !== 'string' || !AUTHORIZATION_ID_RE.test(raw)) {
    return <ConsentNotice message={t('oauth.consent.invalid')} />;
  }
  const here = `/oauth/consent?authorization_id=${raw}`;

  const supabase = await createServerSupabaseClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const claims = claimsData?.claims ?? null;
  // The same one-time acceptance the dashboard asks for: an account created
  // through a provider accepts the instance's documents before it can hand
  // its memory to an agent, and then comes straight back here.
  if (termsGate(legalLinks(), claims) === 'accept') {
    redirect(`/accept-terms?next=${encodeURIComponent(here)}`);
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!claims || !accessToken) {
    redirect(`/login?next=${encodeURIComponent(here)}`);
  }

  const result = await readAuthorization(accessToken, raw);
  if (result.kind === 'redirect') {
    redirect(result.url);
  }
  if (result.kind !== 'details') {
    return (
      <ConsentNotice
        message={t(
          result.kind === 'gone' ? 'oauth.consent.gone' : 'oauth.consent.failed'
        )}
      />
    );
  }

  const { details } = result;
  return (
    <Centered>
      <OAuthConsentView
        authorizationId={details.authorization_id}
        clientName={details.client.client_name}
        returnHost={returnHost(details.redirect_uri)}
        account={typeof claims.email === 'string' ? claims.email : ''}
        labels={{
          title: t('oauth.consent.title', { client: '{client}' }),
          unnamedClient: t('oauth.consent.unnamedClient'),
          description: t('oauth.consent.description'),
          scopes: describeScopes(details.scope, {
            read: t('oauth.consent.scopes.read'),
            write: t('oauth.consent.scopes.write'),
          }),
          returnTo: t('oauth.consent.returnTo', { host: '{host}' }),
          signedInAs: t('oauth.consent.signedInAs', { account: '{account}' }),
          signOut: t('oauth.consent.signOut'),
          allow: t('oauth.consent.allow'),
          allowPending: t('oauth.consent.allowPending'),
          deny: t('oauth.consent.deny'),
        }}
        messages={{
          gone: t('oauth.consent.gone'),
          failed: t('oauth.consent.failed'),
        }}
      />
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      {children}
      <div className="fixed inset-x-0 bottom-3 text-center">
        <BuildVersion />
      </div>
    </main>
  );
}

/** A request that cannot be shown: say why, and offer the way home. */
async function ConsentNotice({ message }: { message: string }) {
  const { t } = await getRequestMessages();
  return (
    <Centered>
      <Card className="w-full max-w-md" data-testid="oauth-consent-notice">
        <CardHeader>
          <CardTitle>{t('oauth.consent.noticeTitle')}</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardFooter>
          <Link href="/" className="text-sm underline underline-offset-2">
            {t('oauth.consent.backToDashboard')}
          </Link>
        </CardFooter>
      </Card>
    </Centered>
  );
}
