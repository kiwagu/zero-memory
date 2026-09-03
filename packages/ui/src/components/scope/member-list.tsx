import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';

/**
 * MemberList — the membership readout of a scope section: display name,
 * an optional "(you)" marker, a role badge and a timestamp. Display-only.
 */

type MemberBadgeVariant = React.ComponentProps<typeof Badge>['variant'];

interface MemberListItem {
  key: string;
  name: string;
  isYou?: boolean;
  roleLabel: string;
  roleVariant?: MemberBadgeVariant;
  /** Preformatted, locale-stable timestamp string. */
  timestamp: string;
  /**
   * Optional state marker shown next to the role, e.g. an invitation that has
   * not been accepted yet. Absent means the ordinary, effective membership.
   */
  statusLabel?: string;
  /** Optional trailing control (e.g. a revoke button); rendered as-is. */
  action?: React.ReactNode;
}

function MemberList({
  items,
  youLabel,
}: {
  items: MemberListItem[];
  youLabel: string;
}) {
  return (
    <ul className="divide-y">
      {items.map((member) => (
        <li
          key={member.key}
          className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
        >
          <span className="break-all">
            {member.name}
            {member.isYou ? (
              <span className="ml-1 text-muted-foreground">({youLabel})</span>
            ) : null}
          </span>
          <span className="flex items-center gap-2">
            {member.statusLabel ? (
              <Badge variant="secondary">{member.statusLabel}</Badge>
            ) : null}
            <Badge variant={member.roleVariant ?? 'secondary'}>
              {member.roleLabel}
            </Badge>
            <time className="text-xs text-muted-foreground">
              {member.timestamp}
            </time>
            {member.action}
          </span>
        </li>
      ))}
    </ul>
  );
}

export { MemberList, type MemberListItem, type MemberBadgeVariant };
