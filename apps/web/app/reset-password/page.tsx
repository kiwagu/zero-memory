import { BuildVersion } from '@/components/build-version';
import { ResetPasswordView } from '@/components/auth/reset-password-view';
import { getRequestMessages } from '@/lib/i18n';

export default async function ResetPasswordPage() {
  const { t } = await getRequestMessages();

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <ResetPasswordView
        mismatchError={t('auth.reset.mismatch')}
        noSessionError={t('auth.reset.noSession')}
        labels={{
          title: t('auth.reset.title'),
          description: t('auth.reset.description'),
          newPassword: t('auth.reset.newPassword'),
          confirmPassword: t('auth.reset.confirmPassword'),
          submit: t('auth.reset.submit'),
          submitPending: t('auth.reset.submitPending'),
        }}
      />
      {/* Rendered only where scripting is off — most often a mail client that
          opens links in a sandboxed view. Without it the form appears, takes a
          password and silently discards it, because neither its handler nor
          even a plain submit can run there. */}
      <noscript>
        <p className="text-muted-foreground max-w-sm text-center text-sm">
          {t('auth.reset.noScript')}
        </p>
      </noscript>
      <div className="fixed inset-x-0 bottom-3 text-center">
        <BuildVersion />
      </div>
    </main>
  );
}
