'use client';

import * as React from 'react';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@workspace/ui/components/sidebar';

interface AppSidebarNavItem {
  href: string;
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
}

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  brand: React.ReactNode;
  items: AppSidebarNavItem[];
  /** Auxiliary items pinned to the sidebar's bottom (e.g. the activity log). */
  footerItems?: AppSidebarNavItem[];
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}

function NavMenu({
  items,
  linkComponent: LinkComponent,
}: {
  items: AppSidebarNavItem[];
  linkComponent: React.ElementType;
}) {
  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.href}>
          <SidebarMenuButton
            isActive={item.active}
            render={<LinkComponent href={item.href} />}
          >
            {item.icon}
            <span>{item.label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

function AppSidebar({
  brand,
  items,
  footerItems,
  linkComponent: LinkComponent = 'a',
  ...props
}: AppSidebarProps) {
  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <div className="px-2 py-1.5 text-sm font-semibold tracking-tight">
          {brand}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <NavMenu items={items} linkComponent={LinkComponent} />
        </SidebarGroup>
      </SidebarContent>
      {footerItems && footerItems.length > 0 ? (
        <SidebarFooter>
          <NavMenu items={footerItems} linkComponent={LinkComponent} />
        </SidebarFooter>
      ) : null}
      <SidebarRail />
    </Sidebar>
  );
}

export { AppSidebar, type AppSidebarNavItem, type AppSidebarProps };
