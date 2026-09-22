import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CardDetail } from '@workspace/ui/components/board/card-detail';

import { BoardLive } from '@/components/board-live.client';
import { getRequestMessages } from '@/lib/i18n';
import { loadCardView } from '@/lib/views/card.view';

/**
 * One card: its document, what it points at, and everything that happened.
 *
 * Rendered by two routes that must not drift — the page a link or a reload
 * lands on, and the dialog a click from the board opens over it. Both show the
 * same thing; only the chrome differs, which is what `variant` selects: a page
 * needs a way back and owns the live subscription, a dialog has its own close
 * and sits on a board that is already subscribed.
 */
export async function CardView({
  id,
  variant = 'page',
}: {
  id: string;
  variant?: 'page' | 'modal';
}) {
  const view = await loadCardView(id);
  if (!view) {
    notFound();
  }
  const { t } = await getRequestMessages();

  return (
    <CardDetail
      {...view.detail}
      linkComponent={Link}
      header={
        variant === 'page' ? (
          <Link
            href="/board"
            className="text-muted-foreground hover:text-foreground w-fit text-sm"
          >
            ← {t('board.back')}
          </Link>
        ) : null
      }
      footer={variant === 'page' ? <BoardLive /> : null}
    />
  );
}
