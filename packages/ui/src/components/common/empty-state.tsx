import * as React from 'react';

import { cn } from '@workspace/ui/lib/utils';

/**
 * EmptyState — the centered, muted "nothing here" paragraph repeated across the
 * KB views (empty folder, empty filter, empty editor, empty canvas). It is the
 * inlined `<p class="text-muted-foreground py-12 text-center text-sm">` lifted to
 * one primitive so the spacing/typography stay identical everywhere. Mechanism
 * only — the message is supplied by the caller (i18n stays in the app).
 *
 * `compact` drops the large vertical padding for the inline variants (e.g. the
 * mini-graph's `py-4` empty note). Semantic tokens only, so dark mode is
 * automatic; extra classes compose via `className`.
 */

export type EmptyStateProps = React.ComponentPropsWithoutRef<'p'> & {
  /** Smaller variant: `py-4` + `text-xs` instead of `py-12` + `text-sm`. */
  compact?: boolean;
};

export function EmptyState({
  className,
  compact = false,
  ...props
}: EmptyStateProps) {
  return (
    <p
      className={cn(
        'text-muted-foreground text-center',
        compact ? 'py-4 text-xs' : 'py-12 text-sm',
        className
      )}
      {...props}
    />
  );
}
