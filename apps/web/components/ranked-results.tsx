import Link from 'next/link';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { EmptyState } from '@workspace/ui/components/common/empty-state';
import { MemoryCard } from '@workspace/ui/components/memory/memory-card';

import { getRequestMessages } from '@/lib/i18n';
import { recallViaServer } from '@/lib/mcp';
import { normalizeScores, searchHitCardProps } from '@/lib/recall';
import { loadScopeMemberCounts } from '@/lib/scope-members';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * The ranked half of the memory feed: runs the caller's query through the
 * server's `recall` tool — the exact search agents use, so a human query
 * returns the identical ids, order, and scores. Hits are rendered strictly in
 * server order; any web-side re-sorting or filtering would break that parity.
 * Each render re-runs a server-side embedding — acceptable because searches
 * are explicit (Enter/button), never per-keystroke.
 */
export async function RankedResults({
  query,
  kinds,
  scope,
  k,
}: {
  query: string;
  kinds: string[];
  scope: string;
  k: number;
}) {
  const { t } = await getRequestMessages();

  const supabase = await createServerSupabaseClient();
  const accessToken = (await supabase.auth.getSession()).data.session
    ?.access_token;
  if (!accessToken) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {t('feed.advanced.loadError', { message: 'not signed in' })}
        </AlertDescription>
      </Alert>
    );
  }

  let hits;
  try {
    ({ memories: hits } = await recallViaServer(accessToken, {
      query,
      kinds: kinds.length > 0 ? kinds : undefined,
      scopes: scope ? [scope] : undefined,
      k,
    }));
  } catch (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {t('feed.advanced.loadError', {
            message: error instanceof Error ? error.message : String(error),
          })}
        </AlertDescription>
      </Alert>
    );
  }

  if (hits.length === 0) {
    return (
      <div className="space-y-3" data-testid="search-results">
        <EmptyState className="rounded-xl border border-dashed">
          {t('feed.advanced.empty')}
        </EmptyState>
      </div>
    );
  }

  // Sharing-badge honesty, same as the chronological feed: "shared" only when
  // the scope truly has members beyond the owner. One RLS-scoped grouped query
  // over the shared scopes among the hits.
  const memberCounts = await loadScopeMemberCounts(
    supabase,
    hits
      .filter((hit) => hit.visibility === 'shared')
      .map((hit) => String(hit.scope))
  );
  const memberCountOf = (
    visibility: string,
    scope: string
  ): number | undefined =>
    visibility === 'shared' ? (memberCounts.get(scope) ?? 0) : undefined;

  // Reconstruct this ranked view's query so a memory opened from a result card
  // returns to the same search on "back to feed" (carried as the `from` param).
  const backToParams = new URLSearchParams();
  backToParams.set('search', query);
  if (kinds.length > 0) backToParams.set('kinds', kinds.join(','));
  if (scope) backToParams.set('sscope', scope);
  backToParams.set('k', String(k));
  const backTo = backToParams.toString();

  return (
    <div className="space-y-3" data-testid="search-results">
      <p className="text-xs text-muted-foreground">
        {t('feed.advanced.results', { count: hits.length })}
      </p>
      {normalizeScores(hits).map((hit) => (
        <MemoryCard
          key={hit.id}
          data-testid="memory-card"
          linkComponent={Link}
          {...searchHitCardProps(
            hit,
            t,
            memberCountOf(hit.visibility, String(hit.scope)),
            backTo
          )}
        />
      ))}
    </div>
  );
}
