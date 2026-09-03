'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  BookMarked,
  Combine,
  Layers,
  Plane,
  Scale,
  ScrollText,
  Settings,
  Sparkles,
  Waypoints,
} from 'lucide-react';

import { AppSidebar } from '@workspace/ui/components/dashboard/app-sidebar';

const NAV_ICONS = {
  memories: <ScrollText />,
  entities: <Waypoints />,
  scopes: <Layers />,
  review: <Scale />,
  rules: <BookMarked />,
  reflections: <Combine />,
  portability: <Plane />,
  insights: <Sparkles />,
  activity: <Activity />,
  settings: <Settings />,
} as const;

export interface DashboardNavItem {
  href: string;
  label: string;
  icon: keyof typeof NAV_ICONS;
}

export function DashboardSidebar({
  brand,
  items,
  footerItems,
}: {
  brand: React.ReactNode;
  items: DashboardNavItem[];
  /** Auxiliary destinations pinned to the sidebar bottom (e.g. activity). */
  footerItems?: DashboardNavItem[];
}) {
  const pathname = usePathname();

  const toNav = ({ href, label, icon }: DashboardNavItem) => ({
    href,
    label,
    icon: NAV_ICONS[icon],
    active: href === '/' ? pathname === '/' : pathname.startsWith(href),
  });

  return (
    <AppSidebar
      brand={brand}
      linkComponent={Link}
      items={items.map(toNav)}
      footerItems={footerItems?.map(toNav)}
    />
  );
}
