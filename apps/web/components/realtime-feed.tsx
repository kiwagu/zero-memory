'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { createWebTranslator } from '@workspace/i18n-catalogs/web';
import { MemoryCard } from '@workspace/ui/components/memory/memory-card';
import { SectionLabel } from '@workspace/ui/components/common/section-label';

import {
  matchesFeedStatus,
  memoryCardProps,
  type FeedStatus,
  type MemoryRow,
} from '@/lib/memory';
import { createClient } from '@/lib/supabase/client';

/**
 * Live prepend of memories inserted while the feed is open. Nice-to-have:
 * RLS decides which INSERTs are delivered; any subscription problem (table
 * not in the realtime publication, websocket down, …) is silently ignored.
 */
export function RealtimeFeed({
  messages,
  memberCounts,
  backTo,
  status,
}: {
  messages: Record<string, string>;
  /**
   * Scope → member count for the scopes present when the page rendered. A new
   * insert into a known scope gets an honest shared/sharable badge; an unknown
   * scope (not on the initial page) falls back to plain "shared" — best-effort,
   * matching this feed's nice-to-have nature.
   */
  memberCounts: Record<string, number>;
  /** The feed's current filters, carried into each card link as `from`. */
  backTo: string;
  /** The feed's lifecycle-status filter — a live insert must respect it too. */
  status: FeedStatus;
}) {
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const t = useMemo(() => createWebTranslator(messages), [messages]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('memories-feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'memories' },
        (payload) => {
          const row = payload.new as MemoryRow;
          setRows((previous) =>
            previous.some((existing) => existing.id === row.id)
              ? previous
              : [row, ...previous]
          );
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  // The status filter applies to live inserts too: a history-only view
  // ("superseded" / "invalidated") is never interrupted by fresh live rows.
  // Filtered at render, not on arrival, so switching the filter re-decides
  // what was already collected instead of stranding it.
  const visible = rows.filter((row) => matchesFeedStatus(row, status));
  if (visible.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <SectionLabel>{t('feed.justAdded')}</SectionLabel>
      {visible.map((memory) => (
        <MemoryCard
          key={memory.id}
          linkComponent={Link}
          {...memoryCardProps(
            memory,
            t,
            false,
            memory.visibility === 'shared'
              ? memberCounts[String(memory.scope)]
              : undefined,
            backTo
          )}
        />
      ))}
    </div>
  );
}
