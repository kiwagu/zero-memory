import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';

/**
 * LinkedMemoryList — the "links in/out" readout of a memory detail page: a
 * relation-type badge next to a preview link, or a muted placeholder when the
 * target is not visible to the viewer. Display-only; hrefs, previews and the
 * placeholder copy arrive resolved from the app.
 */

const PREVIEW_LENGTH = 120;

interface LinkedMemoryItem {
  type: string;
  href?: string;
  preview?: string;
}

interface LinkedMemoryListProps {
  items: LinkedMemoryItem[];
  hiddenLabel: string;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}

function LinkedMemoryList({
  items,
  hiddenLabel,
  linkComponent: LinkComponent = 'a',
}: LinkedMemoryListProps) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="text-sm">
          <Badge variant="secondary" className="mr-2">
            {item.type}
          </Badge>
          {item.href && item.preview !== undefined ? (
            <LinkComponent href={item.href} className="hover:underline">
              {item.preview.length > PREVIEW_LENGTH
                ? `${item.preview.slice(0, PREVIEW_LENGTH)}…`
                : item.preview}
            </LinkComponent>
          ) : (
            <span className="text-muted-foreground">{hiddenLabel}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export { LinkedMemoryList, type LinkedMemoryItem, type LinkedMemoryListProps };
