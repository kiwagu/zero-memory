'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import {
  AdvancedSearchPanel,
  type AdvancedSearchLabels,
  type AdvancedSearchOption,
  type AdvancedSearchValues,
} from '@workspace/ui/components/memory/advanced-search-panel';

import {
  DEFAULT_TOP_K,
  TOP_K_OPTIONS,
  clampTopK,
  parseKindsParam,
} from '@/lib/recall';

/**
 * Ranked-mode URL params, kept disjoint from the narrow feed filters
 * (`q`/`kind`/`scope`/…) so switching modes never cross-contaminates them:
 * `search` (the query — its presence turns ranked mode on), `kinds` (csv),
 * `sscope`, `k`.
 */
const RANKED_PARAMS = ['search', 'kinds', 'sscope', 'k'] as const;

export function AdvancedSearch({
  labels,
  kinds,
  scopes,
}: {
  labels: AdvancedSearchLabels;
  kinds: AdvancedSearchOption[];
  scopes: AdvancedSearchOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const search = searchParams.get('search')?.trim() ?? '';
  const [open, setOpen] = React.useState(Boolean(search));

  function submit(values: AdvancedSearchValues) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('search', values.query);
    if (values.kinds.length > 0) {
      params.set('kinds', values.kinds.join(','));
    } else {
      params.delete('kinds');
    }
    if (values.scope) {
      params.set('sscope', values.scope);
    } else {
      params.delete('sscope');
    }
    if (values.k !== DEFAULT_TOP_K) {
      params.set('k', String(values.k));
    } else {
      params.delete('k');
    }
    params.delete('page');
    navigate(params);
  }

  function clear() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of RANKED_PARAMS) {
      params.delete(key);
    }
    navigate(params);
  }

  // Unlike the cheap feed filters, a ranked render runs a server-side
  // embedding (and possibly a translation) — so never push AND refresh, that
  // would run the search twice. Push when the URL changes (the navigation
  // fetches the new page); refresh only for a same-args resubmit, where the
  // push would be a no-op.
  function navigate(params: URLSearchParams) {
    const next = params.toString();
    if (next === searchParams.toString()) {
      router.refresh();
    } else {
      router.push(next ? `${pathname}?${next}` : pathname);
    }
  }

  return (
    <AdvancedSearchPanel
      labels={labels}
      kinds={kinds}
      scopes={scopes}
      topKOptions={TOP_K_OPTIONS}
      values={{
        query: search,
        kinds: parseKindsParam(searchParams.get('kinds') ?? undefined),
        scope: searchParams.get('sscope') ?? '',
        k: clampTopK(searchParams.get('k') ?? undefined),
      }}
      open={open}
      active={Boolean(search)}
      onToggle={() => setOpen((current) => !current)}
      onSubmit={submit}
      onClear={clear}
    />
  );
}
