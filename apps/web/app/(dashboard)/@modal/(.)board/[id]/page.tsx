import { CardModal } from '@/components/card-modal.client';
import { CardView } from '@/components/card-view';

/**
 * A card reached BY CLICK from the board: same URL, same data, shown over the
 * board instead of replacing it. A reload or a pasted link falls through to
 * the page of its own at the same address.
 */
export default async function InterceptedCardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <CardModal>
      <CardView id={id} variant="modal" />
    </CardModal>
  );
}
