'use client';

import * as React from 'react';

import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select';
import { cn } from '@workspace/ui/lib/utils';
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

interface FeedFilterOption {
  value: string;
  label: string;
  /** How many memories this value yields under the other filters, when known. */
  count?: number;
  /** Yields nothing: shown with its zero and greyed out, never removed. */
  disabled?: boolean;
}

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

const CLEAR_VALUE = '__all__';

/** The option's count, right-aligned and muted; absent when it is unknown. */
function FacetCount({ count }: { count?: number }) {
  if (count === undefined) {
    return null;
  }
  return (
    <span className="ml-auto pl-3 text-xs tabular-nums text-muted-foreground">
      {count}
    </span>
  );
}

function FacetSelect({
  value,
  placeholder,
  placeholderCount,
  options,
  onChange,
  grow = false,
  testId,
}: {
  value: string;
  placeholder: string;
  /** Count behind the placeholder row (the "any value" / default reading). */
  placeholderCount?: number;
  options: FeedFilterOption[];
  onChange: (value: string) => void;
  /** Fill the available row width instead of staying compact (the scope
   * filter on the first row); the value stays truncated. */
  grow?: boolean;
  testId?: string;
}) {
  // Base UI's Select.Value renders the raw value unless the Root gets an
  // items map (value → label) to resolve the display text from.
  const items = React.useMemo(
    () => ({
      [CLEAR_VALUE]: placeholder,
      ...Object.fromEntries(
        options.map((option) => [option.value, option.label])
      ),
    }),
    [options, placeholder]
  );

  return (
    <Select
      value={value || CLEAR_VALUE}
      items={items}
      onValueChange={(next) =>
        onChange(next === CLEAR_VALUE ? '' : String(next))
      }
    >
      {/* The trigger stays compact (truncated); the OPEN list sizes to its
          widest item (the popup default pins width to the trigger via
          --anchor-width, so w-max overrides it), capped at 28rem with the
          full value in the title tooltip past that. */}
      <SelectTrigger
        size="sm"
        className={cn(
          '[&>span]:truncate',
          grow ? 'w-full min-w-48 flex-1' : 'min-w-32 max-w-56'
        )}
        data-testid={testId}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="w-max min-w-(--anchor-width) max-w-[28rem]">
        <SelectItem value={CLEAR_VALUE}>
          <span className="block truncate">{placeholder}</span>
          <FacetCount count={placeholderCount} />
        </SelectItem>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            // An empty value stays in the list, dimmed: removing it would
            // reshuffle the list on every choice and could drop the value the
            // URL currently applies. The applied one is never disabled.
            disabled={option.disabled}
            data-testid={option.disabled ? 'facet-option-empty' : undefined}
          >
            <span className="block max-w-[26rem] truncate" title={option.value}>
              {option.label}
            </span>
            <FacetCount count={option.count} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
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
      {/* Row 1: the two wide fields (content search + project scope) stretch to
          fill the width, with the apply/refresh action pinned at the end; the
          compact facet selects drop to row 2 so nothing wraps mid-row. */}
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
            grow
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
