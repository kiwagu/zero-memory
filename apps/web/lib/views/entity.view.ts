import type { EntityDetailData } from '@workspace/ui/components/entity/entity-detail';

import { getRequestMessages } from '@/lib/i18n';
import { formatTimestamp, kindLabel, scopeLabel } from '@/lib/memory';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { rowsOf } from '@/lib/views/query';

/**
 * One entity as its view needs it — loaded under the viewer's session and
 * rendered by the entity's page or by a panel of the chain. Serializable: a
 * panel receives it as JSON.
 */

/** Edges and memories listed per entity; the graph stays reachable by MCP. */
const LIMIT = 50;

type EdgeRow = {
  type: string;
  src: string;
  dst: string;
  invalidated_at: string | null;
  src_entity: { id: string; name: string } | null;
  dst_entity: { id: string; name: string } | null;
};

type LinkedMemoryRow = {
  memories: { id: string; content: string; kind: string } | null;
};

export interface EntityViewData {
  id: string;
  /** The entity's name — what names it in a panel. */
  title: string;
  detail: EntityDetailData;
}

export async function loadEntityView(
  id: string
): Promise<EntityViewData | null> {
  const supabase = await createServerSupabaseClient();
  const { t } = await getRequestMessages();

  const entity = rowsOf(
    await supabase
      .from('entities')
      .select('id, name, type, scope, created_at')
      .eq('id', id)
      .maybeSingle(),
    'entity'
  );
  if (!entity) {
    return null;
  }

  const [edgesResult, memoriesResult] = await Promise.all([
    supabase
      .from('edges')
      .select(
        'type, src, dst, invalidated_at, ' +
          'src_entity:entities!edges_src_fkey(id, name), ' +
          'dst_entity:entities!edges_dst_fkey(id, name)'
      )
      // The id as the database returned it, never the one from the request:
      // it is spliced into a filter string.
      .or(`src.eq.${entity.id},dst.eq.${entity.id}`)
      .limit(LIMIT),
    supabase
      .from('memory_entities')
      .select('memories(id, content, kind)')
      .eq('entity_id', entity.id)
      .limit(LIMIT),
  ]);
  const edges = (rowsOf(edgesResult, 'entity edges') ??
    []) as unknown as EdgeRow[];
  const memories = (rowsOf(memoriesResult, 'entity memories') ??
    []) as unknown as LinkedMemoryRow[];

  return {
    id: entity.id,
    title: entity.name,
    detail: {
      name: entity.name,
      badges: [
        { label: entity.type, variant: 'blue' },
        { label: scopeLabel(entity.scope), variant: 'amber' },
      ],
      timestamp: formatTimestamp(entity.created_at),
      edges: {
        title: t('entities.connections.edgesTitle'),
        items: edges.map((edge) => ({
          srcName: edge.src_entity?.name ?? edge.src,
          type: edge.type,
          dstName: edge.dst_entity?.name ?? edge.dst,
          invalidated: Boolean(edge.invalidated_at),
        })),
        emptyLabel: t('entities.connections.noEdges'),
        invalidatedLabel: t('memory.invalidated'),
      },
      memories: {
        title: t('entities.connections.memoriesTitle'),
        items: memories.flatMap((row) =>
          row.memories
            ? [
                {
                  type: kindLabel(row.memories.kind, t),
                  href: `/memory/${row.memories.id}`,
                  preview: row.memories.content,
                },
              ]
            : []
        ),
        emptyLabel: t('entities.connections.noMemories'),
        hiddenLabel: t('memory.linkHidden'),
      },
    },
  };
}
