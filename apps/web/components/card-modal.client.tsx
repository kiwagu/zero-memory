'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, type ReactNode } from 'react';

import { Dialog, DialogContent } from '@workspace/ui/components/dialog';

/**
 * The card, opened over the board without leaving it.
 *
 * The URL still changes — the route is intercepted, not faked — so the address
 * bar, a reload and a shared link all name the card the reader is looking at.
 * Dismissing goes BACK rather than pushing the board again, which keeps the
 * history honest: the dialog was a step forward, closing it is the step back.
 *
 * Width matches the memory detail page (`max-w-3xl`) so a card and a memory
 * read at the same measure, and the body scrolls inside the dialog rather than
 * growing past the viewport.
 */
export function CardModal({ children }: { children: ReactNode }) {
  const router = useRouter();
  // The dialog is held open by the route, so its own close signal can arrive
  // more than once before the route actually changes — and a second `back()`
  // would step past the board the reader came from. Dismissal happens once.
  const dismissed = useRef(false);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open || dismissed.current) {
        return;
      }
      dismissed.current = true;
      router.back();
    },
    [router]
  );

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        className="scrollbar-stable max-h-[85vh] overflow-y-auto sm:max-w-3xl"
        data-testid="card-modal"
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
