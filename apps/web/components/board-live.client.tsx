'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { createClient } from '@/lib/supabase/client';

/**
 * Keeps the board current while agents work on it.
 *
 * The board is a window on what other agents are doing, so a page that only
 * updates on reload would show a state that has already moved on. It refetches
 * on the server rather than patching rows in place: every card the reader may
 * see is decided by row-level security, and a payload pushed straight into the
 * view would bypass the read model that answers previews and authorization.
 */
export function BoardLive() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('board-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'cards' },
        () => router.refresh()
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'card_events' },
        () => router.refresh()
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
