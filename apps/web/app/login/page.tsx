import { BuildVersion } from '@/components/build-version';
import { LoginView } from '@/components/auth/login-view';
import { getRequestMessages } from '@/lib/i18n';
import { legalLinks } from '@/lib/legal';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { t } = await getRequestMessages();
  // A failed auth callback redirects here with its reason. Dropping it is how
  // a broken recovery link becomes "clicking the mail did nothing".
  const failure = (await searchParams).error;
  const initialError = typeof failure === 'string' ? failure : undefined;
  // Read here, in the server component, so the addresses stay RUNTIME
  // configuration: the dashboard image is deployment-agnostic, and a value
  // inlined at build time would tie one image to one instance's documents.
  const legal = legalLinks();
  const consentTemplate =
    legal.documents === 'both'
      ? t('auth.consent.template', { terms: '{terms}', privacy: '{privacy}' })
      : legal.documents === 'terms'
        ? t('auth.consent.templateTerms', { terms: '{terms}' })
        : legal.documents === 'privacy'
          ? t('auth.consent.templatePrivacy', { privacy: '{privacy}' })
          : '';

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <LoginView
        initialError={initialError}
        legal={legal}
        consentLabels={{
          // One sentence per configuration: an instance that publishes only
          // one document must not name the other, or the checkbox asks for
          // agreement to something nobody can open. Written as literal keys
          // because that is how they stay greppable — the placeholders are
          // handed back to themselves so the links survive into the form.
          template: consentTemplate,
          termsLabel: t('auth.consent.terms'),
          privacyLabel: t('auth.consent.privacy'),
        }}
        confirmationLabels={{
          title: t('auth.signUp.confirmTitle'),
          // Interpolated client-side with the address actually submitted.
          descriptionTemplate: t('auth.signUp.confirmDescription', {
            email: '{email}',
          }),
          hint: t('auth.signUp.confirmHint'),
          resend: t('auth.signUp.resend'),
          resendPending: t('auth.signUp.resendPending'),
          resent: t('auth.signUp.resent'),
          backToSignIn: t('auth.backToSignIn'),
        }}
        labels={{
          title: t('app.title'),
          signInDescription: t('auth.signInDescription'),
          signUpDescription: t('auth.signUpDescription'),
          email: t('auth.email'),
          password: t('auth.password'),
          signIn: t('auth.signIn'),
          signInPending: t('auth.signInPending'),
          signUp: t('auth.signUp'),
          signUpPending: t('auth.signUpPending'),
          forgotPassword: t('auth.forgotPassword'),
          noAccount: t('auth.noAccount'),
          createOne: t('auth.createOne'),
          haveAccount: t('auth.haveAccount'),
          switchToSignIn: t('auth.signIn'),
        }}
      />
      <div className="fixed inset-x-0 bottom-3 text-center">
        <BuildVersion />
      </div>
    </main>
  );
}
