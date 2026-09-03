import * as React from 'react';

import { cn } from '@workspace/ui/lib/utils';

/**
 * SectionLabel — the uppercase, muted, semibold tracking-label header shared across
 * the app's section headers (resource-panel sections, the Share dialog audience
 * groups, drive card rails, the drive sidebar, the lens breadcrumb shelf).
 *
 * Generic and context-free: it owns only the typographic cluster
 * (`text-muted-foreground font-semibold uppercase` + a density-driven size/tracking).
 * Layout (flex / margins / padding) and any leading icon are the caller's, supplied
 * via `icon` and `className`, so every former hand-roll renders an identical class set.
 */
const DENSITY_CLASS = {
  /** text-xs / 0.04em — panel sections, share groups, card rails. */
  default: 'text-xs tracking-[0.04em]',
  /** text-[11px] / 0.04em — the drive sidebar's compact section heading. */
  compact: 'text-[11px] tracking-[0.04em]',
  /** text-xs / 0.02em — the lens breadcrumb shelf. */
  tight: 'text-xs tracking-[0.02em]',
} as const;

export type SectionLabelDensity = keyof typeof DENSITY_CLASS;

function SectionLabel({
  density = 'default',
  icon,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  density?: SectionLabelDensity;
  icon?: React.ReactNode;
}) {
  return (
    <div
      data-slot="section-label"
      className={cn(
        'text-muted-foreground font-semibold uppercase',
        DENSITY_CLASS[density],
        className
      )}
      {...props}
    >
      {icon}
      {children}
    </div>
  );
}

export { SectionLabel };
