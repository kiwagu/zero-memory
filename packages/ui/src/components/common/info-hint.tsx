import { Info } from 'lucide-react';
import * as React from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';

/**
 * InfoHint — a small info icon beside a heading that shows its text on hover or
 * keyboard focus. For copy a reader needs once rather than on every visit (what
 * a page is, how it is configured): the page keeps to its content and the
 * explanation stays one hover away.
 *
 * Display-only: `label` (the icon's accessible name) and the text arrive
 * translated from the caller. `testId` marks the icon, and `<testId>-content`
 * the text while it is open.
 */
function InfoHint({
  label,
  testId,
  className,
  children,
}: {
  label: string;
  testId?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        data-testid={testId}
        className={cn(
          'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]',
          className
        )}
      >
        <Info className="size-4" aria-hidden />
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        className="max-w-sm flex-col items-start"
        data-testid={testId ? `${testId}-content` : undefined}
      >
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

export { InfoHint };
