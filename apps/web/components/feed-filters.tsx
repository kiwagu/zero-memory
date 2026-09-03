'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import {
  FeedFilters as FeedFiltersUi,
  type FeedFilterOption,
  type FeedFiltersLabels,
  type FeedFiltersProps,
} from '@workspace/ui/components/memory/feed-filters';

export function FeedFilters({
  labels,
  kinds,
  visibilities,
  scopes,
  statuses,
  placeholderCounts,
}: {
  labels: FeedFiltersLabels;
  kinds: FeedFilterOption[];
  visibilities: FeedFilterOption[];
  scopes: FeedFilterOption[];
  statuses: FeedFilterOption[];
  placeholderCounts?: FeedFiltersProps['placeholderCounts'];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function apply(updates: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
    }
    params.delete('page');
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
    // Also re-fetch: when the filters are unchanged the push is a no-op, so
    // the Filter button doubles as a "refresh the feed" action.
    router.refresh();
  }

  return (
    <FeedFiltersUi
      labels={labels}
      kinds={kinds}
      visibilities={visibilities}
      scopes={scopes}
      statuses={statuses}
      placeholderCounts={placeholderCounts}
      values={{
        q: searchParams.get('q') ?? '',
        kind: searchParams.get('kind') ?? '',
        visibility: searchParams.get('visibility') ?? '',
        scope: searchParams.get('scope') ?? '',
        // Only an offered (non-default) status selects a row; anything else —
        // absent, the default spelled out by hand, a typo — falls back to the
        // placeholder, which is what the page renders anyway.
        status: statuses.some(
          (option) => option.value === searchParams.get('status')
        )
          ? (searchParams.get('status') as string)
          : '',
      }}
      onApply={apply}
    />
  );
}
