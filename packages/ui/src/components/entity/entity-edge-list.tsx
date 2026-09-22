import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';

/**
 * EntityEdgeList — an entity's graph edges as `src —type→ dst` lines, with a
 * mark on an edge that is no longer valid. Display-only; names and labels
 * arrive resolved from the app.
 */

interface EntityEdgeItem {
  srcName: string;
  type: string;
  dstName: string;
  invalidated?: boolean;
}

function EntityEdgeList({
  edges,
  invalidatedLabel,
  emptyLabel,
}: {
  edges: EntityEdgeItem[];
  invalidatedLabel: string;
  emptyLabel: string;
}) {
  if (edges.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-1">
      {edges.map((edge, index) => (
        <li key={index} className="text-xs">
          <span className="font-medium">{edge.srcName}</span>
          <Badge variant="secondary" className="mx-1.5">
            {edge.type}
          </Badge>
          <span className="font-medium">{edge.dstName}</span>
          {edge.invalidated ? (
            <span className="ml-1.5 text-destructive">
              ({invalidatedLabel})
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export { EntityEdgeList, type EntityEdgeItem };
