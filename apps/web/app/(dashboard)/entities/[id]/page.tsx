import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EntityDetail } from '@workspace/ui/components/entity/entity-detail';

import { loadEntityView } from '@/lib/views/entity.view';

/**
 * One entity by id: its edges and the memories that mention it. A memory's
 * entity chip leads here, so the reader lands on THIS entity rather than on a
 * name search that may match several.
 */
export default async function EntityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const view = await loadEntityView(id);
  if (!view) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl">
      <EntityDetail {...view.detail} linkComponent={Link} />
    </div>
  );
}
