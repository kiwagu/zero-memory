'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { boardChannelChanges, boardScopesKey } from '@/lib/board';
import { createClient } from '@/lib/supabase/client';

/** What a board's channel carries: the operation on a card or its stream. */
const BOARD_EVENTS = ['INSERT', 'UPDATE', 'DELETE'] as const;

type BoardClient = ReturnType<typeof createClient>;
type BoardChannel = ReturnType<BoardClient['channel']>;

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
 *
 * A channel starts hearing its board a few seconds after it joins, so a board
 * that stays on screen keeps its channel: the page joins the boards that came
 * on screen and leaves the ones that went, and a refresh that only reorders
 * the boards changes nothing.
 */
export function BoardLive({ scopes }: { scopes: string[] }) {
  const router = useRouter();
  const key = boardScopesKey(scopes);
  const client = useRef<{ supabase: BoardClient; ready: Promise<void> } | null>(
    null
  );
  const channels = useRef(new Map<string, BoardChannel>());

  // One client and one authorized socket for as long as the page is open. A
  // private channel is authorized by the reader's token, so the socket must
  // carry it before the first join.
  useEffect(() => {
    const supabase = createClient();
    client.current = { supabase, ready: supabase.realtime.setAuth() };
    const open = channels.current;
    return () => {
      for (const channel of open.values()) {
        void supabase.removeChannel(channel);
      }
      open.clear();
      client.current = null;
    };
  }, []);

  useEffect(() => {
    const current = client.current;
    if (!current) {
      return;
    }
    let cancelled = false;
    void current.ready.then(() => {
      if (cancelled || client.current !== current) {
        return;
      }
      const open = channels.current;
      const { join, leave } = boardChannelChanges(
        new Set(open.keys()),
        key ? key.split('\n') : []
      );
      for (const scope of leave) {
        const channel = open.get(scope);
        if (channel) {
          void current.supabase.removeChannel(channel);
        }
        open.delete(scope);
      }
      for (const scope of join) {
        const channel = current.supabase.channel(`board:${scope}`, {
          config: { private: true },
        });
        for (const event of BOARD_EVENTS) {
          channel.on('broadcast', { event }, () => router.refresh());
        }
        open.set(scope, channel.subscribe());
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, router]);

  return null;
}
