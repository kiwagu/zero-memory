'use client';

import * as React from 'react';

import { Button } from '@workspace/ui/components/button';
import { Separator } from '@workspace/ui/components/separator';
import { SidebarTrigger } from '@workspace/ui/components/sidebar';
import {
  ThemeSwitcher,
  type ThemeSwitcherLabels,
} from '@workspace/ui/components/common/theme-switcher';

interface DashboardHeaderLabels {
  signOut: string;
  theme: ThemeSwitcherLabels;
}

interface DashboardHeaderProps {
  /** What to show: the account's chosen name, else its address's local part. */
  displayName: string;
  /** The full address — kept as a tooltip, not printed into every screen. */
  email: string;
  labels: DashboardHeaderLabels;
  /** Infrastructure is injected by the app: auth sign-out lives outside this package. */
  onSignOut: () => void | Promise<void>;
}

function DashboardHeader({
  displayName,
  email,
  labels,
  onSignOut,
}: DashboardHeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <div className="flex-1" />
      <ThemeSwitcher labels={labels.theme} />
      <span
        className="text-sm text-muted-foreground"
        title={email}
        data-testid="account-name"
      >
        {displayName}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void onSignOut()}
      >
        {labels.signOut}
      </Button>
    </header>
  );
}

export {
  DashboardHeader,
  type DashboardHeaderLabels,
  type DashboardHeaderProps,
};
