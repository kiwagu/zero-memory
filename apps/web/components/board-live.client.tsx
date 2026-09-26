'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { createClient } from '@/lib/supabase/client';

/** What a board's channel carries: the operation on a card or its stream. */
const BOARD_EVENTS = ['INSERT', 'UPDATE', 'DELETE'] as const;

/**
 * Keeps the board current while agents work on it.
 *
 * The board is a window on what other agents are doing, so a page that only
 * updates on reload would show a state that has already moved on. Every change
 * to a card or its stream is broadcast on the PRIVATE channel of its board,
 * `board:<scope>`, and the store admits only that board's readers to it. The
 * page listens to the boards it shows and refetches on the server rather than
 * patching rows in place: every card the reader may see is decided by
 * row-level security, and a payload pushed straight into the view would bypass
 * the read model that answers previews and authorization.
 */
export function BoardLive({ scopes }: { scopes: string[] }) {
  const router = useRouter();
  // The effect depends on WHICH boards, not on a new array every render.
  const key = scopes.join('\n');

  useEffect(() => {
    const boards = key ? key.split('\n') : [];
    const supabase = createClient();
    let cancelled = false;
    const channels: ReturnType<typeof supabase.channel>[] = [];

    void (async () => {
      // A private channel is authorized by the reader's token, so the socket
      // must carry it before the first join.
      await supabase.realtime.setAuth();
      if (cancelled) {
        return;
      }
      for (const scope of boards) {
        const channel = supabase.channel(`board:${scope}`, {
          config: { private: true },
        });
        for (const event of BOARD_EVENTS) {
          channel.on('broadcast', { event }, () => router.refresh());
        }
        channels.push(channel.subscribe());
      }
    })();

    return () => {
      cancelled = true;
      for (const channel of channels) {
        void supabase.removeChannel(channel);
      }
    };
  }, [router, key]);

  return null;
}
