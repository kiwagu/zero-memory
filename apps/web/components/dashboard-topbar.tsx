'use client';

import {
  DashboardHeader,
  type DashboardHeaderLabels,
} from '@workspace/ui/components/dashboard/dashboard-header';

import { createClient } from '@/lib/supabase/client';

export function DashboardTopbar({
  displayName,
  email,
  labels,
}: {
  displayName: string;
  email: string;
  labels: DashboardHeaderLabels;
}) {
  async function handleSignOut() {
    const supabase = createClient();
    // Scope 'local' ends only this browser session. The default ('global')
    // revokes every session of the user — including MCP client and watcher
    // sessions, which then fail refresh and demand re-authorization.
    await supabase.auth.signOut({ scope: 'local' });
    window.location.assign('/login');
  }

  return (
    <DashboardHeader
      displayName={displayName}
      email={email}
      labels={labels}
      onSignOut={handleSignOut}
    />
  );
}
