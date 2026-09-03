import { BuildVersion } from '@/components/build-version';
import { ForgotPasswordView } from '@/components/auth/forgot-password-view';
import { getRequestMessages } from '@/lib/i18n';

export default async function ForgotPasswordPage() {
  const { t } = await getRequestMessages();

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <ForgotPasswordView
        labels={{
          title: t('auth.forgot.title'),
          description: t('auth.forgot.description'),
          email: t('auth.email'),
          submit: t('auth.forgot.submit'),
          submitPending: t('auth.forgot.submitPending'),
          backToSignIn: t('auth.backToSignIn'),
        }}
        sentLabels={{
          title: t('auth.forgot.sentTitle'),
          // Interpolated client-side with the address actually submitted.
          descriptionTemplate: t('auth.forgot.sentDescription', {
            email: '{email}',
          }),
          hint: t('auth.forgot.sentHint'),
          resend: t('auth.forgot.resend'),
          resendPending: t('auth.forgot.resendPending'),
          resent: t('auth.forgot.resent'),
          backToSignIn: t('auth.backToSignIn'),
        }}
      />
      <div className="fixed inset-x-0 bottom-3 text-center">
        <BuildVersion />
      </div>
    </main>
  );
}
