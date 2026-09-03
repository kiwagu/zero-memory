import * as React from 'react';

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import { EmptyState } from '@workspace/ui/components/common/empty-state';
import { cn } from '@workspace/ui/lib/utils';

/**
 * One row in {@link TopFactsList}. Fully pre-formatted by the caller so i18n,
 * number formatting, and the "shared memory" placeholder for content the caller
 * cannot see stay in the app.
 */
export type TopFactItem = {
  id: string;
  /** The fact's content, or a placeholder for a not-owned (shared) memory. */
  primary: string;
  /** Optional meta line (e.g. the kind label). */
  meta?: string;
  /** Pre-formatted surfaced-count badge text (e.g. "×4"). */
  count: string;
  /**
   * Detail-page href for this memory. Set only for memories the caller owns
   * (readable) — a not-owned/shared fact has no href and stays non-clickable,
   * since its detail page is not viewable.
   */
  href?: string;
};

/**
 * TopFactsList — the "facts that fired most" panel of the value dashboard. Ranks
 * are decided upstream (the RPC returns them ordered); this only renders. Rows
 * for owned memories link to the memory detail via `linkComponent`.
 */
export function TopFactsList({
  title,
  items,
  emptyLabel,
  linkComponent: LinkComponent = 'a',
  ...props
}: React.ComponentPropsWithoutRef<'div'> & {
  title: string;
  items: TopFactItem[];
  emptyLabel: string;
  linkComponent?: React.ElementType;
}) {
  return (
    <Card {...props}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <EmptyState compact>{emptyLabel}</EmptyState>
        ) : (
          <ul className="divide-border divide-y">
            {items.map((item) => {
              const Row = item.href ? LinkComponent : 'div';
              return (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <Row
                    {...(item.href ? { href: item.href } : {})}
                    className={cn(
                      'block min-w-0',
                      item.href && 'group hover:text-foreground'
                    )}
                  >
                    <p
                      className={cn(
                        'truncate text-sm',
                        item.href && 'group-hover:underline'
                      )}
                    >
                      {item.primary}
                    </p>
                    {item.meta ? (
                      <p className="text-muted-foreground text-xs">
                        {item.meta}
                      </p>
                    ) : null}
                  </Row>
                  <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
                    {item.count}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
