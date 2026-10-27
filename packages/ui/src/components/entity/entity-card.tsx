import * as React from 'react';

import {
  BadgeList,
  type BadgeListItem,
} from '@workspace/ui/components/common/badge-list';

/**
 * EntityCard — an entity's name, badges and timestamp in one header row, with
 * an optional details area as children. The list unit of the entities page and
 * the header of an entity's own page. Display-only.
 */

interface EntityCardProps {
  name: string;
  badges: BadgeListItem[];
  /** Preformatted, locale-stable timestamp string. */
  timestamp: string;
  /** Where the name leads — the entity's own page. */
  href?: string;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
  children?: React.ReactNode;
}

function EntityCard({
  name,
  badges,
  timestamp,
  href,
  linkComponent: LinkComponent = 'a',
  children,
}: EntityCardProps) {
  return (
    <div className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium" data-testid="entity-name">
          {href ? (
            <LinkComponent href={href} className="hover:underline">
              {name}
            </LinkComponent>
          ) : (
            name
          )}
        </span>
        <span className="flex items-center gap-1.5">
          <BadgeList badges={badges} />
          <time className="text-xs text-muted-foreground">{timestamp}</time>
        </span>
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

export { EntityCard, type EntityCardProps };
