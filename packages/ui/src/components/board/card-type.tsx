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
 * The icon leads the severity ticks on the line under a card's label, small
 * enough that both fit the label's width. A card that predates types draws a
 * muted dashed circle, so the gap is visible rather than silent.
 * Display-only: the type and the hint that names it arrive from the app.
 */
type CardTypeValue = 'story' | 'bug' | 'task' | 'spike';

interface CardTypeProps {
  /** Why the work exists, or null on a card that predates types. */
  type: CardTypeValue | null;
  /** The type in words, for hover and assistive readers. */
  hint: string;
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

function CardType({ type, hint, className }: CardTypeProps) {
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
    </span>
  );
}

export { CardType, type CardTypeProps, type CardTypeValue };
