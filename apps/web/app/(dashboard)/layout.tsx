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
  modal,
}: Readonly<{
  children: React.ReactNode;
  /**
   * Parallel slot for a route shown OVER the page beneath it — a card opened
   * from the board. It renders alongside `children` rather than replacing
   * them, which is what keeps the board visible behind the dialog while the
   * address bar names the card.
   */
  modal: React.ReactNode;
}>) {
  const supabase = await createServerSupabaseClient();
  const account = await currentAccount(supabase);
  const { t } = await getRequestMessages();

  const nav: DashboardNavItem[] = [
    { href: '/', label: t('nav.insights'), icon: 'insights' },
    { href: '/memories', label: t('nav.memories'), icon: 'memories' },
    { href: '/board', label: t('nav.board'), icon: 'board' },
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
      {/* min-w-0: the inset is a flex item beside the sidebar, and without it
          a page wider than the window (the board's scrolling row) would widen
          the whole inset instead of scrolling inside its own container. */}
      <SidebarInset className="min-w-0">
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
        {modal}
      </SidebarInset>
    </SidebarProvider>
  );
}
