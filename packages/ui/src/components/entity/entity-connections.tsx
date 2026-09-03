import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';

/**
 * EntityConnections — the lazy `<details>` readout of an entity's graph
 * neighborhood: edges (src —type→ dst) and linked memories. Mechanism only:
 * data arrives display-ready, fetching is the caller's `onOpen` callback.
 */

interface EntityEdgeItem {
  srcName: string;
  type: string;
  dstName: string;
  invalidated?: boolean;
}

interface EntityMemoryItem {
  href: string;
  preview: string;
  kind: string;
}

interface EntityConnectionsLabels {
  summary: string;
  loading: string;
  edgesTitle: string;
  noEdges: string;
  memoriesTitle: string;
  noMemories: string;
  invalidated: string;
}

interface EntityConnectionsProps {
  labels: EntityConnectionsLabels;
  loading: boolean;
  data: { edges: EntityEdgeItem[]; memories: EntityMemoryItem[] } | null;
  onOpen: () => void;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}

const PREVIEW_LENGTH = 120;

function EntityConnections({
  labels,
  loading,
  data,
  onOpen,
  linkComponent: LinkComponent = 'a',
}: EntityConnectionsProps) {
  return (
    <details
      onToggle={(event) => {
        if ((event.target as HTMLDetailsElement).open) {
          onOpen();
        }
      }}
    >
      <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
        {labels.summary}
      </summary>
      <div className="mt-2 space-y-3 border-l-2 pl-3">
        {loading ? (
          <p className="text-xs text-muted-foreground">{labels.loading}</p>
        ) : null}
        {data ? (
          <>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {labels.edgesTitle} ({data.edges.length})
              </p>
              {data.edges.length > 0 ? (
                <ul className="space-y-1">
                  {data.edges.map((edge, index) => (
                    <li key={index} className="text-xs">
                      <span className="font-medium">{edge.srcName}</span>
                      <Badge variant="secondary" className="mx-1.5">
                        {edge.type}
                      </Badge>
                      <span className="font-medium">{edge.dstName}</span>
                      {edge.invalidated ? (
                        <span className="ml-1.5 text-destructive">
                          ({labels.invalidated})
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {labels.noEdges}
                </p>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {labels.memoriesTitle} ({data.memories.length})
              </p>
              {data.memories.length > 0 ? (
                <ul className="space-y-1">
                  {data.memories.map((memory, index) => (
                    <li key={index} className="text-xs">
                      <LinkComponent
                        href={memory.href}
                        className="hover:underline"
                      >
                        {memory.preview.length > PREVIEW_LENGTH
                          ? `${memory.preview.slice(0, PREVIEW_LENGTH)}…`
                          : memory.preview}
                      </LinkComponent>
                      <span className="ml-1.5 text-muted-foreground">
                        {memory.kind}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {labels.noMemories}
                </p>
              )}
            </div>
          </>
        ) : null}
      </div>
    </details>
  );
}

export {
  EntityConnections,
  type EntityConnectionsLabels,
  type EntityConnectionsProps,
  type EntityEdgeItem,
  type EntityMemoryItem,
};
