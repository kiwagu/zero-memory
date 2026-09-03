import * as React from 'react';

/**
 * EntityChipList — the linked-entities rail of a detail page: pill links with
 * a name and a muted type. Display-only; hrefs and labels arrive resolved.
 */

interface EntityChipItem {
  href: string;
  name: string;
  type: string;
}

interface EntityChipListProps {
  items: EntityChipItem[];
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}

function EntityChipList({
  items,
  linkComponent: LinkComponent = 'a',
}: EntityChipListProps) {
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((item, index) => (
        <li key={index}>
          <LinkComponent
            href={item.href}
            className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-xs hover:bg-muted"
          >
            <span className="font-medium">{item.name}</span>
            <span className="text-muted-foreground">{item.type}</span>
          </LinkComponent>
        </li>
      ))}
    </ul>
  );
}

export { EntityChipList, type EntityChipItem, type EntityChipListProps };
