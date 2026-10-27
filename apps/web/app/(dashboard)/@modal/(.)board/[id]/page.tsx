import { notFound } from 'next/navigation';

import { CardDetail } from '@workspace/ui/components/board/card-detail';

import { CardModal } from '@/components/card-modal.client';
import {
  PanelLink,
  type PanelChainLabels,
} from '@/components/panel-chain.client';
import { getRequestMessages } from '@/lib/i18n';
import { loadCardView } from '@/lib/views/card.view';

/**
 * A card reached BY CLICK from the board: same URL, same data, shown over the
 * board instead of replacing it — and the first panel of the chain its links
 * open. A reload or a pasted link falls through to the page of its own at the
 * same address.
 */
export default async function InterceptedCardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const view = await loadCardView(id);
  if (!view) {
    notFound();
  }
  const { t } = await getRequestMessages();
  const labels: PanelChainLabels = {
    previous: t('panels.previous'),
    next: t('panels.next'),
    close: t('panels.close'),
    from: t('panels.from', { title: '{title}' }),
    loading: t('panels.loading'),
    unavailable: t('panels.unavailable'),
    retry: t('panels.retry'),
    kind: {
      memory: t('panels.kind.memory'),
      card: t('panels.kind.card'),
      entity: t('panels.kind.entity'),
    },
  };

  return (
    <CardModal cardId={id} rootTitle={view.title} labels={labels}>
      <CardDetail {...view.detail} linkComponent={PanelLink} />
    </CardModal>
  );
}
