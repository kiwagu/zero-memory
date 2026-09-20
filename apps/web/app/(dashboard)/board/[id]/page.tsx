import { CardView } from '@/components/card-view';

/**
 * A card reached directly: a reload, a pasted link, or a back/forward step
 * past the board. The same view the dialog shows, at the same width as a
 * memory's own page.
 */
export default async function CardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div className="mx-auto max-w-3xl p-4">
      <CardView id={id} />
    </div>
  );
}
