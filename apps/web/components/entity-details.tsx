'use client';

import Link from 'next/link';
import { useState } from 'react';

import {
  EntityConnections,
  type EntityConnectionsLabels,
} from '@workspace/ui/components/entity/entity-connections';

import { createClient } from '@/lib/supabase/client';

type EdgeRow = {
  id: string;
  type: string;
  weight: number;
  src: string;
  dst: string;
  invalidated_at: string | null;
  src_entity: { id: string; name: string } | null;
  dst_entity: { id: string; name: string } | null;
};

type LinkedMemoryRow = {
  memory_id: string;
  memories: { id: string; content: string; kind: string } | null;
};

type Details = {
  edges: EdgeRow[];
  memories: LinkedMemoryRow[];
};

export function EntityDetails({
  entityId,
  labels,
}: {
  entityId: string;
  labels: EntityConnectionsLabels;
}) {
  const [details, setDetails] = useState<Details | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (details || loading) {
      return;
    }
    setLoading(true);
    const supabase = createClient();
    const [edgesResult, memoriesResult] = await Promise.all([
      supabase
        .from('edges')
        .select(
          'id, type, weight, src, dst, invalidated_at, ' +
            'src_entity:entities!edges_src_fkey(id, name), ' +
            'dst_entity:entities!edges_dst_fkey(id, name)'
        )
        .or(`src.eq.${entityId},dst.eq.${entityId}`)
        .limit(50),
      supabase
        .from('memory_entities')
        .select('memory_id, memories(id, content, kind)')
        .eq('entity_id', entityId)
        .limit(50),
    ]);
    setDetails({
      edges: (edgesResult.data ?? []) as unknown as EdgeRow[],
      memories: (memoriesResult.data ?? []) as unknown as LinkedMemoryRow[],
    });
    setLoading(false);
  }

  return (
    <EntityConnections
      labels={labels}
      loading={loading}
      linkComponent={Link}
      onOpen={() => void load()}
      data={
        details
          ? {
              edges: details.edges.map((edge) => ({
                srcName: edge.src_entity?.name ?? edge.src,
                type: edge.type,
                dstName: edge.dst_entity?.name ?? edge.dst,
                invalidated: Boolean(edge.invalidated_at),
              })),
              memories: details.memories.flatMap((row) =>
                row.memories
                  ? [
                      {
                        href: `/memory/${row.memories.id}`,
                        preview: row.memories.content,
                        kind: row.memories.kind,
                      },
                    ]
                  : []
              ),
            }
          : null
      }
    />
  );
}
