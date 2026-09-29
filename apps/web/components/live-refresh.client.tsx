'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { createClient } from '@/lib/supabase/client';

/** What a reader's channel names: the surface whose data changed. */
export type LiveRefreshEvent = 'memories' | 'board';

/**
 * A burst of changes (an agent writing several memories, a card and its
 * stream entry) lands as one refresh.
 */
const SETTLE_MS = 300;

/**
 * Listens on the reader's private channel, `reader:<readerId>`, and refreshes
 * the page when the store nudges it about `event`.
 *
 * A nudge carries no content: the page fetches again on the server, where
 * row-level security, the page's filters and its ordering decide what shows.
 * The channel only says when to look again, and the store admits nobody but
 * the reader to it.
 *
 * A channel starts hearing the store a few seconds after it joins, so a page
 * that has just opened follows changes a moment late.
 */
export function LiveRefreshListener({
  readerId,
  event,
}: {
  readerId: string;
  event: LiveRefreshEvent;
}) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const refresh = () => {
      clearTimeout(settle);
      settle = setTimeout(() => router.refresh(), SETTLE_MS);
    };
    // A private channel is authorized by the reader's token, so the socket
    // must carry it before the join.
    void supabase.realtime.setAuth().then(() => {
      if (cancelled) {
        return;
      }
      channel = supabase
        .channel(`reader:${readerId}`, { config: { private: true } })
        .on('broadcast', { event }, refresh)
        .subscribe();
    });
    return () => {
      cancelled = true;
      clearTimeout(settle);
      if (channel) {
        void supabase.removeChannel(channel);
      }
    };
  }, [readerId, event, router]);

  return null;
}
