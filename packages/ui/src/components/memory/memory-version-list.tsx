import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';

/**
 * MemoryVersionList — the supersession lineage of a memory, oldest first: each
 * version is a row with its kind, timestamp and a preview link, the current
 * one highlighted and non-navigable. Display-only; hrefs, previews, labels and
 * the ordered items arrive resolved from the app (vendor-neutral).
 */

const PREVIEW_LENGTH = 120;

interface MemoryVersionItem {
  href: string;
  preview: string;
  timestamp: string;
  kindLabel: string;
  isCurrent: boolean;
  invalidated: boolean;
}

interface MemoryVersionListProps {
  items: MemoryVersionItem[];
  currentLabel: string;
  invalidatedLabel: string;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}

function truncate(text: string): string {
  return text.length > PREVIEW_LENGTH
    ? `${text.slice(0, PREVIEW_LENGTH)}…`
    : text;
}

function MemoryVersionList({
  items,
  currentLabel,
  invalidatedLabel,
  linkComponent: LinkComponent = 'a',
}: MemoryVersionListProps) {
  return (
    <ol className="space-y-3">
      {items.map((item, index) => (
        <li
          key={item.href}
          className="relative border-l-2 pl-4"
          data-current={item.isCurrent || undefined}
        >
          <span
            className={
              item.isCurrent
                ? 'absolute -left-[5px] top-1 size-2 rounded-full bg-primary'
                : 'absolute -left-[5px] top-1 size-2 rounded-full bg-muted-foreground/40'
            }
            aria-hidden
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">v{index + 1}</span>
            <Badge variant="blue">{item.kindLabel}</Badge>
            {item.isCurrent ? (
              <Badge variant="green">{currentLabel}</Badge>
            ) : null}
            {item.invalidated ? (
              <Badge variant="secondary">{invalidatedLabel}</Badge>
            ) : null}
            <span>{item.timestamp}</span>
          </div>
          <div className="mt-1 text-sm">
            {item.isCurrent ? (
              <span className="whitespace-pre-wrap">
                {truncate(item.preview)}
              </span>
            ) : (
              <LinkComponent href={item.href} className="hover:underline">
                {truncate(item.preview)}
              </LinkComponent>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export {
  MemoryVersionList,
  type MemoryVersionItem,
  type MemoryVersionListProps,
};
