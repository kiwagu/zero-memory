'use client';

import * as React from 'react';

import { Button } from '@workspace/ui/components/button';
import {
  FacetSelect,
  type FacetOption,
} from '@workspace/ui/components/common/facet-select';
import { Input } from '@workspace/ui/components/input';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@workspace/ui/components/tooltip';

/**
 * FeedFilters — search + facet selects for the memory feed. Pure mechanism:
 * option lists and labels arrive translated, the URL/router side effect is the
 * injected `onApply` callback (an empty string value clears that filter).
 */

/** The feed's own name for the shared facet option shape. */
type FeedFilterOption = FacetOption;

interface FeedFiltersLabels {
  searchPlaceholder: string;
  allKinds: string;
  allVisibilities: string;
  allScopes: string;
  /** The lifecycle-status select's default row (an empty status value). */
  defaultStatus: string;
  submit: string;
  /** Tooltip: clarifies that submitting also re-fetches the feed. */
  submitHint: string;
}

interface FeedFiltersProps {
  labels: FeedFiltersLabels;
  kinds: FeedFilterOption[];
  visibilities: FeedFilterOption[];
  scopes: FeedFilterOption[];
  /** The non-default lifecycle statuses; the default is the placeholder row. */
  statuses: FeedFilterOption[];
  /** Counts behind each facet's placeholder row, when the caller knows them. */
  placeholderCounts?: {
    kind?: number;
    visibility?: number;
    scope?: number;
    status?: number;
  };
  values: {
    q: string;
    kind: string;
    visibility: string;
    scope: string;
    status: string;
  };
  onApply: (updates: Record<string, string>) => void;
}

function FeedFilters({
  labels,
  kinds,
  visibilities,
  scopes,
  statuses,
  placeholderCounts,
  values,
  onApply,
}: FeedFiltersProps) {
  // Controlled so the native search "×" clears the applied filter (an empty
  // onChange), without the uncontrolled defaultValue-after-init warning. When
  // the applied query changes elsewhere (navigation / another filter's apply)
  // the box re-syncs by adjusting state during render — the effect-free React
  // idiom, so no set-state-in-effect.
  const [q, setQ] = React.useState(values.q);
  const [appliedQ, setAppliedQ] = React.useState(values.q);
  if (values.q !== appliedQ) {
    setAppliedQ(values.q);
    setQ(values.q);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onApply({ q });
      }}
      className="w-full space-y-2"
    >
      {/* Row 1: the search field stretches to fill what the scope picker does
          not take, with the apply/refresh action pinned at the end; the
          compact facet selects drop to row 2 so nothing wraps mid-row. The
          scope picker is sized like every other scope picker in the app —
          as wide as the board or project it names. */}
      <div className="flex w-full flex-wrap items-center gap-2">
        <Input
          type="search"
          name="q"
          value={q}
          onChange={(event) => {
            const next = event.target.value;
            setQ(next);
            // Clearing the field (the native search "×") drops the q filter.
            if (next === '' && values.q !== '') {
              onApply({ q: '' });
            }
          }}
          placeholder={labels.searchPlaceholder}
          className="h-8 min-w-48 flex-1"
        />
        {scopes.length > 0 ? (
          <FacetSelect
            width="content"
            value={values.scope}
            placeholder={labels.allScopes}
            placeholderCount={placeholderCounts?.scope}
            options={scopes}
            onChange={(scope) => onApply({ scope })}
          />
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button type="submit" variant="outline" size="sm">
                {labels.submit}
              </Button>
            }
          />
          <TooltipContent>{labels.submitHint}</TooltipContent>
        </Tooltip>
      </div>
      {/* Row 2: the compact facet selects. */}
      <div className="flex w-full flex-wrap items-center gap-2">
        <FacetSelect
          value={values.kind}
          placeholder={labels.allKinds}
          placeholderCount={placeholderCounts?.kind}
          options={kinds}
          onChange={(kind) => onApply({ kind })}
          testId="feed-filter-kind"
        />
        <FacetSelect
          value={values.visibility}
          placeholder={labels.allVisibilities}
          placeholderCount={placeholderCounts?.visibility}
          options={visibilities}
          onChange={(visibility) => onApply({ visibility })}
          testId="feed-filter-visibility"
        />
        {/* Lifecycle status. Its default is the placeholder row (an empty
            value), so picking it back clears the param instead of pinning the
            default into the URL. */}
        <FacetSelect
          value={values.status}
          placeholder={labels.defaultStatus}
          placeholderCount={placeholderCounts?.status}
          options={statuses}
          onChange={(status) => onApply({ status })}
          testId="feed-filter-status"
        />
      </div>
    </form>
  );
}

export {
  FeedFilters,
  type FeedFilterOption,
  type FeedFiltersLabels,
  type FeedFiltersProps,
};
