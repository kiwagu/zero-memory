'use client';

import * as React from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select';
import { cn } from '@workspace/ui/lib/utils';

/**
 * FacetSelect — one filter select whose DEFAULT is the placeholder row rather
 * than a value of its own.
 *
 * That shape is the point: the placeholder is a real, re-selectable row bound
 * to a sentinel, and choosing it reports an EMPTY value, which the caller
 * turns into "drop this parameter from the URL". So the default view is both
 * explicitly re-selectable and absent from the address — a bare page link
 * keeps meaning "the default".
 *
 * Extracted from the memory feed's filters when the board needed the same
 * control; it carries no feature vocabulary, so it lives with the other
 * generic mechanisms.
 */

interface FacetOption {
  value: string;
  label: string;
  /** How many rows this value yields under the other filters, when known. */
  count?: number;
  /** Yields nothing: shown with its zero and greyed out, never removed. */
  disabled?: boolean;
}

const CLEAR_VALUE = '__all__';

/** The option's count, right-aligned and muted; absent when it is unknown. */
function FacetCount({ count }: { count?: number }) {
  if (count === undefined) {
    return null;
  }
  return (
    <span className="text-muted-foreground ml-auto pl-3 text-xs tabular-nums">
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
  width = 'compact',
  testId,
}: {
  value: string;
  placeholder: string;
  /** Count behind the placeholder row (the "any value" / default reading). */
  placeholderCount?: number;
  options: FacetOption[];
  onChange: (value: string) => void;
  /**
   * How wide the trigger is allowed to be:
   *   compact — a fixed band (a row of several facets stays aligned);
   *   content — as wide as its own label, so the value is not eaten;
   *   grow    — fills the row it shares.
   */
  width?: 'compact' | 'content' | 'grow';
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
          width === 'grow' && 'w-full min-w-48 flex-1',
          width === 'content' && 'w-auto max-w-[28rem]',
          width === 'compact' && 'max-w-56 min-w-32'
        )}
        data-testid={testId}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="w-max max-w-[28rem] min-w-(--anchor-width)">
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

export { FacetSelect, FacetCount, CLEAR_VALUE, type FacetOption };
