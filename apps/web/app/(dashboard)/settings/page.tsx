import { SettingsDeleteAccount } from '@/components/settings-delete-account';
import { SettingsMemoryPanel } from '@/components/settings-memory-panel';
import { SettingsProfile } from '@/components/settings-profile';
import { SettingsProviderKey } from '@/components/settings-provider-key';
import { currentAccount } from '@/lib/account';
import { readCredentialStatus } from '@/lib/credential-status';
import { getRequestMessages } from '@/lib/i18n';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export default async function SettingsPage() {
  const { t } = await getRequestMessages();
  const credential = await readCredentialStatus();
  const supabase = await createServerSupabaseClient();
  const account = await currentAccount(supabase);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{t('settings.title')}</h1>
        <p className="text-muted-foreground text-sm">
          {t('settings.description')}
        </p>
      </div>

      <SettingsProfile
        email={account.email}
        name={account.name}
        labels={{
          title: t('settings.profile.title'),
          description: t('settings.profile.description'),
          emailLabel: t('settings.profile.email'),
          nameLabel: t('settings.profile.name'),
          namePlaceholder: t('settings.profile.namePlaceholder'),
          nameHint: t('settings.profile.nameHint'),
          save: t('settings.profile.save'),
          saving: t('settings.profile.saving'),
          saved: t('settings.profile.saved'),
        }}
      />

      <SettingsMemoryPanel
        labels={{
          exportTitle: t('settings.export.title'),
          exportDescription: t('settings.export.description'),
          exportAction: t('settings.export.action'),
          exportHint: t('settings.export.hint'),
          exportPreparing: t('settings.export.preparing'),
          exportProgress: t('settings.export.progress'),
          importTitle: t('settings.import.title'),
          importDescription: t('settings.import.description'),
          importDropHint: t('settings.import.dropHint'),
          importBrowse: t('settings.import.browse'),
          importProgress: t('settings.import.progress'),
          importReset: t('settings.import.reset'),
          summaryTemplate: t('settings.import.summary'),
        }}
      />

      <SettingsProviderKey
        current={
          credential
            ? {
                provider: credential.provider,
                model: credential.model,
                baseUrl: credential.baseUrl,
                hint: credential.hint,
              }
            : null
        }
        labels={{
          title: t('settings.providerKey.title'),
          description: t('settings.providerKey.description'),
          providerLabel: t('settings.providerKey.provider'),
          keyLabel: t('settings.providerKey.key'),
          keyPlaceholder: t('settings.providerKey.keyPlaceholder'),
          modelLabel: t('settings.providerKey.model'),
          modelPlaceholder: t('settings.providerKey.modelPlaceholder'),
          baseUrlLabel: t('settings.providerKey.baseUrl'),
          baseUrlPlaceholder: t('settings.providerKey.baseUrlPlaceholder'),
          save: t('settings.providerKey.save'),
          saving: t('settings.providerKey.saving'),
          installed: t('settings.providerKey.installed'),
          revoke: t('settings.providerKey.revoke'),
          revoking: t('settings.providerKey.revoking'),
          hint: t('settings.providerKey.hint'),
        }}
      />

      <SettingsDeleteAccount
        email={account.email}
        labels={{
          title: t('settings.deleteAccount.title'),
          description: t('settings.deleteAccount.description'),
          trigger: t('settings.deleteAccount.trigger'),
          confirmTitle: t('settings.deleteAccount.confirmTitle'),
          warning: t('settings.deleteAccount.warning'),
          exportHint: t('settings.deleteAccount.exportHint'),
          exportAction: t('settings.deleteAccount.exportAction'),
          confirmPrompt: t('settings.deleteAccount.confirmPrompt'),
          confirmPlaceholder: t('settings.deleteAccount.confirmPlaceholder'),
          cancel: t('settings.deleteAccount.cancel'),
          confirm: t('settings.deleteAccount.confirm'),
          deleting: t('settings.deleteAccount.deleting'),
        }}
      />
    </div>
  );
}
