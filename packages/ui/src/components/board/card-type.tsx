import {
  BookmarkIcon,
  BugIcon,
  CircleDashedIcon,
  FlaskConicalIcon,
  SquareCheckIcon,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import { cn } from '@workspace/ui/lib/utils';

/**
 * CardType — why a card's work exists, as the icon most boards use for it:
 * a story (a feature from the user's side), a bug (a product function is
 * broken), a task (neither: docs, tests, refactoring, ops) or a spike (the
 * output is an answer, not a change).
 *
 * The icon alone fits under a board tile's label; the open card writes the
 * type beside it. A card that predates types draws a muted dashed circle, so
 * the gap is visible rather than silent. Display-only: the type, its words
 * and the hint arrive from the app.
 */
type CardTypeValue = 'story' | 'bug' | 'task' | 'spike';

interface CardTypeProps {
  /** Why the work exists, or null on a card that predates types. */
  type: CardTypeValue | null;
  /** The type in words, for hover and assistive readers. */
  hint: string;
  /** The type written beside the icon, on the open card. */
  label?: string;
  className?: string;
}

const ICONS: Record<CardTypeValue, { icon: LucideIcon; tone: string }> = {
  story: { icon: BookmarkIcon, tone: 'text-green-600 dark:text-green-400' },
  bug: { icon: BugIcon, tone: 'text-red-600 dark:text-red-400' },
  task: { icon: SquareCheckIcon, tone: 'text-blue-600 dark:text-blue-400' },
  spike: {
    icon: FlaskConicalIcon,
    tone: 'text-violet-600 dark:text-violet-400',
  },
};

const UNDECLARED = {
  icon: CircleDashedIcon,
  tone: 'text-muted-foreground/60',
};

function CardType({ type, hint, label, className }: CardTypeProps) {
  const { icon: Icon, tone } = type ? ICONS[type] : UNDECLARED;
  return (
    <span
      role="img"
      aria-label={hint}
      title={hint}
      data-testid="card-type"
      data-type={type ?? 'none'}
      className={cn('inline-flex items-center gap-1', className)}
    >
      <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', tone)} />
      {label ? (
        <span className="text-muted-foreground text-xs">{label}</span>
      ) : null}
    </span>
  );
}

export { CardType, type CardTypeProps, type CardTypeValue };
