'use client';

import * as React from 'react';

import { installRequestActivity } from '@workspace/ui/lib/request-activity';
import { createSyncVisibility } from '@workspace/ui/lib/sync-visibility';
import { cn } from '@workspace/ui/lib/utils';

/**
 * A thin bar across the very top of the viewport while the page waits on the
 * server. Without it a slow call or a server re-render shows nothing at all,
 * and the page looks as if nothing is happening.
 *
 * Mount it ONCE, in the root layout. It watches every request through the
 * shared request counter, so no call site wires it. The look follows the
 * indeterminate state of `ProgressBar`: a third-width `primary` segment, here
 * sliding along a 2px line; with reduced motion it stands still across the
 * whole width. Vendor-neutral: the accessible label is passed in.
 */
export function SyncProgressBar({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const activity = installRequestActivity();
    const visibility = createSyncVisibility(setVisible);
    visibility.update(activity.pending());
    const unsubscribe = activity.subscribe((pending) =>
      visibility.update(pending)
    );
    return () => {
      unsubscribe();
      visibility.dispose();
    };
  }, []);

  if (!visible) {
    return null;
  }
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-busy="true"
      data-testid="sync-progress-bar"
      className={cn(
        'pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden',
        className
      )}
    >
      <div className="bg-primary animate-sync-bar h-full w-1/3 motion-reduce:w-full motion-reduce:animate-none" />
    </div>
  );
}
