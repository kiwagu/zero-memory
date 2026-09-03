import {
  SidebarInset,
  SidebarProvider,
} from '@workspace/ui/components/sidebar';

import { BuildVersion } from '@/components/build-version';

import {
  DashboardSidebar,
  type DashboardNavItem,
} from '@/components/dashboard-sidebar';
import { DashboardTopbar } from '@/components/dashboard-topbar';
import { currentAccount } from '@/lib/account';
import { getRequestMessages } from '@/lib/i18n';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await createServerSupabaseClient();
  const account = await currentAccount(supabase);
  const { t } = await getRequestMessages();

  const nav: DashboardNavItem[] = [
    { href: '/', label: t('nav.insights'), icon: 'insights' },
    { href: '/memories', label: t('nav.memories'), icon: 'memories' },
    { href: '/entities', label: t('nav.entities'), icon: 'entities' },
    { href: '/scopes', label: t('nav.scopes'), icon: 'scopes' },
    { href: '/review', label: t('nav.review'), icon: 'review' },
    { href: '/rules', label: t('nav.rules'), icon: 'rules' },
    { href: '/reflections', label: t('nav.reflections'), icon: 'reflections' },
    { href: '/portability', label: t('nav.portability'), icon: 'portability' },
  ];
  // Auxiliary observability surface — pinned to the sidebar bottom, out of
  // the primary navigation flow.
  const footerNav: DashboardNavItem[] = [
    { href: '/activity', label: t('nav.activity'), icon: 'activity' },
    { href: '/settings', label: t('nav.settings'), icon: 'settings' },
  ];

  return (
    <SidebarProvider>
      <DashboardSidebar
        brand={
          <>
            {t('app.title')} <BuildVersion />
          </>
        }
        items={nav}
        footerItems={footerNav}
      />
      <SidebarInset>
        <DashboardTopbar
          displayName={account.displayName}
          email={account.email}
          labels={{
            signOut: t('header.signOut'),
            theme: {
              ariaLabel: t('theme.ariaLabel'),
              light: t('theme.light'),
              dark: t('theme.dark'),
              system: t('theme.system'),
            },
          }}
        />
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
