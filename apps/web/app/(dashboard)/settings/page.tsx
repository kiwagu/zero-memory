import { SettingsConnectedAgents } from '@/components/settings-connected-agents';
import { SettingsDeleteAccount } from '@/components/settings-delete-account';
import { SettingsMemoryPanel } from '@/components/settings-memory-panel';
import { SettingsProfile } from '@/components/settings-profile';
import { SettingsProviderKey } from '@/components/settings-provider-key';
import { SettingsSecurity } from '@/components/settings-security';
import { currentAccount } from '@/lib/account';
import { readConnectedAgents } from '@/lib/connected-agents';
import { readCredentialStatus } from '@/lib/credential-status';
import { getRequestMessages } from '@/lib/i18n';
import { formatTimestamp } from '@/lib/memory';
import { readAssurance } from '@/lib/mfa';
import { currentSubjectId } from '@/lib/subject';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export default async function SettingsPage() {
  const { t } = await getRequestMessages();
  const credential = await readCredentialStatus();
  const supabase = await createServerSupabaseClient();
  const account = await currentAccount(supabase);
  // Deleting the account is confirmed with the second factor; an account
  // without one turns it on first. (The layout already made a session with a
  // factor give the code before any settings page opened.)
  const { verifiedFactors } = await readAssurance(supabase);
  const subjectId = await currentSubjectId();
  const agents = subjectId ? await readConnectedAgents(subjectId) : [];

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

      <SettingsSecurity
        labels={{
          title: t('settings.security.title'),
          description: t('settings.security.description'),
          start: t('settings.security.start'),
          scanHint: t('settings.security.scanHint'),
          secretHint: t('settings.security.secretHint'),
          code: t('settings.security.code'),
          confirm: t('settings.security.confirm'),
          confirming: t('settings.security.confirming'),
          cancel: t('settings.security.cancel'),
          enabled: t('settings.security.enabled'),
          addedOn: t('settings.security.addedOn', { date: '{date}' }),
          remove: t('settings.security.remove'),
          removeNeedsCode: t('settings.security.removeNeedsCode'),
        }}
        messages={{
          refused: t('settings.security.refused'),
          failed: t('settings.security.failed'),
          appName: t('settings.security.appName'),
        }}
      />

      <SettingsConnectedAgents
        agents={agents.map((agent) => ({
          clientId: agent.client_id,
          name: agent.client_name,
          returnAddress: agent.redirect_uri,
          approvedOn: formatTimestamp(agent.granted_at),
          lastUsed:
            agent.last_used_at === null
              ? null
              : formatTimestamp(agent.last_used_at),
        }))}
        labels={{
          title: t('settings.agents.title'),
          description: t('settings.agents.description'),
          empty: t('settings.agents.empty'),
          unnamed: t('settings.agents.unnamed'),
          returnsTo: t('settings.agents.returnsTo', { address: '{address}' }),
          approvedOn: t('settings.agents.approvedOn', { date: '{date}' }),
          lastUsed: t('settings.agents.lastUsed', { date: '{date}' }),
          noSession: t('settings.agents.noSession'),
          revoke: t('settings.agents.revoke'),
          confirmTitle: t('settings.agents.confirmTitle', { name: '{name}' }),
          confirmDescription: t('settings.agents.confirmDescription'),
          cancel: t('settings.agents.cancel'),
          confirm: t('settings.agents.confirm'),
          revoking: t('settings.agents.revoking'),
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
        blockedReason={
          verifiedFactors === 0
            ? t('settings.deleteAccount.needsTwoFactor')
            : null
        }
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
