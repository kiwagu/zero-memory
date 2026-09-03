import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';

/**
 * BadgeList — a wrapping row of badges. Display-only: labels arrive
 * translated, tones map to Badge variants.
 */

type BadgeListVariant = React.ComponentProps<typeof Badge>['variant'];

interface BadgeListItem {
  label: string;
  variant?: BadgeListVariant;
  /** Optional stable e2e selector rendered onto this badge. */
  testId?: string;
}

function BadgeList({ badges }: { badges: BadgeListItem[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {badges.map(({ label, variant = 'secondary', testId }, index) => (
        <Badge key={`${label}-${index}`} variant={variant} data-testid={testId}>
          {label}
        </Badge>
      ))}
    </div>
  );
}

export { BadgeList, type BadgeListItem, type BadgeListVariant };
