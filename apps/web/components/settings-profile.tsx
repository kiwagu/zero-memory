'use client';

import { useRouter } from 'next/navigation';

import {
  ProfilePanel,
  type ProfileLabels,
} from '@workspace/ui/components/settings/profile-panel';

import { saveDisplayName } from '@/lib/profile.actions';

/**
 * Client wrapper: the panel is presentation, the server action does the write.
 *
 * A successful save refreshes the route so the header — rendered by the
 * dashboard layout from the session's claims — picks the new name up in the
 * same interaction, instead of showing the old one until the next navigation.
 */
export function SettingsProfile({
  labels,
  email,
  name,
}: {
  labels: ProfileLabels;
  email: string;
  name: string;
}) {
  const router = useRouter();

  return (
    <ProfilePanel
      labels={labels}
      email={email}
      name={name}
      onSave={async (value) => {
        const result = await saveDisplayName(value);
        if (result.ok) {
          router.refresh();
        }
        return result;
      }}
    />
  );
}
