import * as React from 'react';

import { buttonVariants } from '@workspace/ui/components/button';
import { cn } from '@workspace/ui/lib/utils';

/**
 * FeedPagination — newer/older cursor row for the feed. Links only (no state):
 * the app computes the hrefs and injects its router link component.
 */

interface FeedPaginationProps {
  newerHref?: string;
  olderHref?: string;
  pageLabel: string;
  newerLabel: string;
  olderLabel: string;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}

function FeedPagination({
  newerHref,
  olderHref,
  pageLabel,
  newerLabel,
  olderLabel,
  linkComponent: LinkComponent = 'a',
}: FeedPaginationProps) {
  const linkClassName = cn(buttonVariants({ variant: 'outline', size: 'sm' }));

  return (
    <div className="flex items-center justify-between text-sm">
      {newerHref ? (
        <LinkComponent href={newerHref} className={linkClassName}>
          {newerLabel}
        </LinkComponent>
      ) : (
        <span />
      )}
      <span className="text-muted-foreground">{pageLabel}</span>
      {olderHref ? (
        <LinkComponent href={olderHref} className={linkClassName}>
          {olderLabel}
        </LinkComponent>
      ) : (
        <span />
      )}
    </div>
  );
}

export { FeedPagination, type FeedPaginationProps };
