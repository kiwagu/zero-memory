import * as React from 'react';

import {
  BadgeList,
  type BadgeListItem,
} from '@workspace/ui/components/common/badge-list';

/**
 * EntityCard — the list unit of the entities page: name, badges and timestamp
 * in the header row, an expandable details area as children. Display-only.
 */

interface EntityCardProps {
  name: string;
  badges: BadgeListItem[];
  /** Preformatted, locale-stable timestamp string. */
  timestamp: string;
  children?: React.ReactNode;
}

function EntityCard({ name, badges, timestamp, children }: EntityCardProps) {
  return (
    <div className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{name}</span>
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
