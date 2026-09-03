import { Languages } from 'lucide-react';

import { cn } from '@workspace/ui/lib/utils';

export interface OriginalDisclosureLabels {
  /** Toggle text, e.g. "Original (ja)". */
  toggle: string;
}

interface OriginalDisclosureProps {
  /** The original-language source text to reveal. */
  text: string;
  /** BCP-47-ish code for the `lang` attribute (accessibility); optional. */
  lang?: string | null;
  labels: OriginalDisclosureLabels;
  className?: string;
}

/**
 * Reveals a memory's original-language source alongside its canonical-English
 * content — both a reader aid and a manual drift-audit tool (compare the
 * rendering against what was actually said). A native `<details>`: no client
 * JS, so it works inside server components. The text reveals as a full-width
 * block below the toggle, for a detail card with room to compare side by side;
 * the feed card, where the toggle sits in a tight header corner, splits the two
 * with a CSS-only pattern of its own instead.
 */
function OriginalDisclosure({
  text,
  lang,
  labels,
  className,
}: OriginalDisclosureProps) {
  return (
    <details
      data-testid="memory-original"
      className={cn('mt-2 text-xs', className)}
    >
      <summary
        data-testid="memory-original-toggle"
        className="inline-flex cursor-pointer list-none items-center gap-1 text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden"
      >
        <Languages className="size-3.5" aria-hidden />
        {labels.toggle}
      </summary>
      <div
        data-testid="memory-original-text"
        lang={lang ?? undefined}
        className="mt-2 rounded-md bg-muted p-3 break-words whitespace-pre-wrap text-muted-foreground"
      >
        {text}
      </div>
    </details>
  );
}

export { OriginalDisclosure, type OriginalDisclosureProps };
