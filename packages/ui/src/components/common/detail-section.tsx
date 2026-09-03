import * as React from 'react';

import { SectionLabel } from '@workspace/ui/components/common/section-label';
import { cn } from '@workspace/ui/lib/utils';

/**
 * DetailSection — a titled card-like section used on detail pages: an uppercase
 * muted heading over arbitrary content. Mechanism only — the title arrives
 * translated from the caller.
 */
function DetailSection({
  title,
  className,
  children,
  ...props
}: React.ComponentProps<'section'> & { title: React.ReactNode }) {
  return (
    <section
      className={cn(
        'rounded-xl border bg-card p-4 text-card-foreground shadow-sm',
        className
      )}
      {...props}
    >
      <SectionLabel className="mb-3">{title}</SectionLabel>
      {children}
    </section>
  );
}

export { DetailSection };
