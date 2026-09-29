import * as React from 'react';

import { cn } from '@workspace/ui/lib/utils';

/**
 * CardSeverity — how much a card matters, as five ticks filled up to its
 * level: 1 minimal, 2 low, 3 normal, 4 high, 5 urgent.
 *
 * Drawn at every level, the normal one included, so the scale reads the same
 * on every card: three of five is the resting state, one tick is a card that
 * can wait, five is one that cannot. The tone rises with the level — muted
 * below normal, amber at high, red at urgent. Display-only: the level and
 * the hint that names it in words arrive from the app.
 */
interface CardSeverityProps {
  /** 1 to 5. */
  level: number;
  /** The level in words, for hover and assistive readers. */
  hint: string;
  className?: string;
}

const TICKS = [1, 2, 3, 4, 5] as const;

const tone = (level: number): string => {
  if (level >= 5) return 'bg-red-500 dark:bg-red-400';
  if (level === 4) return 'bg-amber-500 dark:bg-amber-400';
  if (level === 3) return 'bg-foreground/55';
  return 'bg-muted-foreground/45';
};

function CardSeverity({ level, hint, className }: CardSeverityProps) {
  return (
    <span
      role="img"
      aria-label={hint}
      title={hint}
      data-testid="card-severity"
      data-severity={level}
      className={cn('inline-flex items-center gap-0.5', className)}
    >
      {TICKS.map((tick) => {
        const filled = tick <= level;
        return (
          <span
            key={tick}
            data-filled={filled ? 'true' : 'false'}
            className={cn(
              'h-2 w-1 rounded-[1px]',
              filled ? tone(level) : 'bg-border'
            )}
          />
        );
      })}
    </span>
  );
}

export { CardSeverity, type CardSeverityProps };
