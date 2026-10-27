'use client';

import * as React from 'react';

/**
 * CardLabelLink — a card's `ZM-N` label as a pill that is also the card's
 * link. A plain click copies the card's full address, ready to paste into a
 * chat, a note or a commit message; a click with a modifier, the middle
 * button and the context menu behave like any other link. Labels arrive
 * translated from the app.
 */

interface CardLabelLinkProps {
  label: string;
  /** The card's own page, e.g. `/board/crd_…`. */
  href: string;
  /** Tooltip saying what a click does. */
  copyHint: string;
  /** Shown in place of the label for a moment after a copy. */
  copiedLabel: string;
}

function CardLabelLink({
  label,
  href,
  copyHint,
  copiedLabel,
}: CardLabelLinkProps) {
  const [copied, setCopied] = React.useState(false);
  return (
    <a
      href={href}
      title={copyHint}
      data-testid="card-number"
      data-copied={copied || undefined}
      className="text-muted-foreground hover:text-foreground hover:bg-muted shrink-0 rounded-md border px-1.5 py-0.5 text-sm whitespace-nowrap tabular-nums transition-colors"
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        const address = new URL(href, window.location.href).toString();
        void navigator.clipboard.writeText(address).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined
        );
      }}
    >
      {copied ? copiedLabel : label}
    </a>
  );
}

export { CardLabelLink, type CardLabelLinkProps };
