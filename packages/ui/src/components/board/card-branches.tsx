import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';

/**
 * CardBranches — where a card's work ran: each git branch with its
 * repository and whether it is still open or where it landed — the latest
 * landing on the badge, any earlier ones beside it. Display-only;
 * every label arrives translated from the app.
 */

interface CardBranchItem {
  key: string;
  name: string;
  repo: string;
  /** "open", or "landed as <sha> on <target>", already translated. */
  stateLabel: string;
  /**
   * The landings before the latest ("earlier <sha>, …"), already translated;
   * null when the branch landed at most once.
   */
  earlierLabel: string | null;
  landed: boolean;
}

function CardBranches({ items }: { items: CardBranchItem[] }) {
  return (
    <ul className="flex flex-col gap-2" data-testid="card-branches">
      {items.map((item) => (
        <li
          key={item.key}
          className="flex flex-wrap items-baseline gap-2 text-sm"
          data-testid="card-branch"
        >
          <span className="font-mono">{item.name}</span>
          <span className="text-muted-foreground font-mono text-xs">
            {item.repo}
          </span>
          <Badge
            variant={item.landed ? 'green' : 'blue'}
            data-testid="card-branch-state"
          >
            {item.stateLabel}
          </Badge>
          {item.earlierLabel ? (
            <span
              className="text-muted-foreground font-mono text-xs"
              data-testid="card-branch-earlier"
            >
              {item.earlierLabel}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export { CardBranches, type CardBranchItem };
