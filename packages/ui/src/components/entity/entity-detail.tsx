import * as React from 'react';

import type { BadgeListItem } from '@workspace/ui/components/common/badge-list';
import { DetailSection } from '@workspace/ui/components/common/detail-section';
import { EntityCard } from '@workspace/ui/components/entity/entity-card';
import {
  EntityEdgeList,
  type EntityEdgeItem,
} from '@workspace/ui/components/entity/entity-edge-list';
import {
  LinkedMemoryList,
  type LinkedMemoryItem,
} from '@workspace/ui/components/memory/linked-memory-list';

/**
 * EntityDetail — one entity with what surrounds it: its graph edges and the
 * memories that mention it. Rendered by the entity's page and by a panel of
 * the chain; everything arrives display-ready and serializable.
 */

interface EntityDetailData {
  name: string;
  badges: BadgeListItem[];
  timestamp: string;
  edges: {
    title: string;
    items: EntityEdgeItem[];
    emptyLabel: string;
    invalidatedLabel: string;
  };
  memories: {
    title: string;
    items: LinkedMemoryItem[];
    emptyLabel: string;
    hiddenLabel: string;
  };
}

interface EntityDetailProps extends EntityDetailData {
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}

function EntityDetail({
  name,
  badges,
  timestamp,
  edges,
  memories,
  linkComponent = 'a',
}: EntityDetailProps) {
  return (
    <div className="space-y-4" data-testid="entity-detail">
      <EntityCard name={name} badges={badges} timestamp={timestamp} />

      <DetailSection title={`${edges.title} (${edges.items.length})`}>
        <EntityEdgeList
          edges={edges.items}
          invalidatedLabel={edges.invalidatedLabel}
          emptyLabel={edges.emptyLabel}
        />
      </DetailSection>

      <DetailSection title={`${memories.title} (${memories.items.length})`}>
        {memories.items.length > 0 ? (
          <LinkedMemoryList
            items={memories.items}
            hiddenLabel={memories.hiddenLabel}
            linkComponent={linkComponent}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{memories.emptyLabel}</p>
        )}
      </DetailSection>
    </div>
  );
}

export { EntityDetail, type EntityDetailData, type EntityDetailProps };
