'use client';

import { useRouter } from 'next/navigation';
import {
  useCallback,
  useReducer,
  useRef,
  type ComponentProps,
  type ReactNode,
} from 'react';

import { Dialog, DialogContent } from '@workspace/ui/components/dialog';

import {
  PanelChain,
  type PanelChainLabels,
} from '@/components/panel-chain.client';
import { chainReducer, initialChain } from '@/lib/panel-chain';

type ChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Dialog>['onOpenChange']>
>[1];

/**
 * The card, opened over the board without leaving it — and the chain of panels
 * its links open to its right.
 *
 * The URL still changes — the route is intercepted, not faked — so the address
 * bar, a reload and a shared link all name the card the reader is looking at.
 * Dismissing goes BACK rather than pushing the board again, which keeps the
 * history honest: the dialog was a step forward, closing it is the step back.
 * The chain itself lives only here: opening panels does not change the URL.
 *
 * Each panel has the card dialog's measure (`max-w-3xl`), so a card and a
 * memory read the same, and a panel's body scrolls inside it rather than
 * growing past the viewport.
 */
export function CardModal({
  cardId,
  rootTitle,
  labels,
  children,
}: {
  cardId: string;
  rootTitle: string;
  labels: PanelChainLabels;
  children: ReactNode;
}) {
  const router = useRouter();
  // The dialog is held open by the route, so its own close signal can arrive
  // more than once before the route actually changes — and a second `back()`
  // would step past the board the reader came from. Dismissal happens once.
  const dismissed = useRef(false);
  const [chain, dispatch] = useReducer(
    chainReducer,
    { kind: 'card' as const, id: cardId },
    initialChain
  );

  const dismiss = useCallback(() => {
    if (dismissed.current) {
      return;
    }
    dismissed.current = true;
    router.back();
  }, [router]);

  const handleOpenChange = useCallback(
    (open: boolean, details: ChangeDetails) => {
      if (open) {
        return;
      }
      // Escape unwinds the chain first; only a lone card closes the dialog.
      if (details.reason === 'escape-key' && chain.panels.length > 1) {
        dispatch({ type: 'closeLast' });
        return;
      }
      dismiss();
    },
    [chain.panels.length, dismiss]
  );

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 block h-screen w-screen max-w-none translate-x-0 translate-y-0 rounded-none bg-transparent p-0 ring-0 sm:max-w-none"
        data-testid="card-modal"
      >
        <PanelChain
          state={chain}
          dispatch={dispatch}
          root={children}
          rootTitle={rootTitle}
          labels={labels}
          onCloseRoot={dismiss}
        />
      </DialogContent>
    </Dialog>
  );
}
