'use client';

import {
  DeleteAccountPanel,
  type DeleteAccountLabels,
} from '@workspace/ui/components/settings/delete-account-panel';

import { createClient } from '@/lib/supabase/client';

/**
 * Client wrapper: the panel is presentation, the route handler does the work.
 *
 * On a successful deletion the account and its sign-in principal are gone, so
 * every session is already invalid at the source. This still clears the
 * browser's own cookies locally — a network revoke would target a user that no
 * longer exists — and sends the user to the login page.
 */
export function SettingsDeleteAccount({
  labels,
  email,
}: {
  labels: DeleteAccountLabels;
  email: string;
}) {
  return (
    <DeleteAccountPanel
      labels={labels}
      confirmationValue={email}
      onExport={() => {
        // Reuse the existing audited export route; a download attribute makes it
        // save rather than navigate.
        const anchor = document.createElement('a');
        anchor.href = '/settings/export';
        anchor.download = '';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }}
      onDelete={async () => {
        const response = await fetch('/settings/delete-account', {
          method: 'POST',
        });
        if (!response.ok) {
          const message = await response.text().catch(() => '');
          return { ok: false, error: message || 'Request failed.' };
        }
        await createClient()
          .auth.signOut({ scope: 'local' })
          .catch(() => undefined);
        window.location.assign('/login');
        return { ok: true };
      }}
    />
  );
}
