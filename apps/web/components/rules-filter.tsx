'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { FacetSelect } from '@workspace/ui/components/common/facet-select';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select';

export interface RulesFilterOption {
  value: string;
  label: string;
}

/** Scope-facet sentinel: the "all scopes" (no scope filter) row. */
const SCOPE_ALL = '__all__';

/**
 * The /rules filter bar: a scope + a status dropdown driving URL params (the
 * server component re-queries). Scope clears to "all scopes"; status is a
 * plain select whose options already include an explicit "all statuses" row,
 * so the status filter can always be reset — it is a real value, never a
 * disappearing default. Pinned and delivery are facets whose default ("any")
 * is the placeholder row, absent from the URL until one is chosen.
 */
export function RulesFilter({
  scope,
  status,
  pinned,
  delivery,
  scopes,
  statuses,
  pinnedOptions,
  deliveryOptions,
  labels,
}: {
  scope: string;
  /** One of the status values (incl. the explicit "all" option). */
  status: string;
  /** `pinned` / `unpinned`, or empty for any. */
  pinned: string;
  /** `delivered` / `undelivered`, or empty for any. */
  delivery: string;
  scopes: RulesFilterOption[];
  statuses: RulesFilterOption[];
  pinnedOptions: RulesFilterOption[];
  deliveryOptions: RulesFilterOption[];
  labels: { allScopes: string; pinnedAny: string; deliveryAny: string };
}) {
  const router = useRouter();

  function apply(next: {
    scope?: string;
    status?: string;
    pinned?: string;
    delivery?: string;
  }) {
    const query = new URLSearchParams();
    const nextScope = next.scope ?? scope;
    const nextStatus = next.status ?? status;
    const nextPinned = next.pinned ?? pinned;
    const nextDelivery = next.delivery ?? delivery;
    if (nextScope) query.set('scope', nextScope);
    // `pending` is the default queue → omit it from the URL for a clean path.
    if (nextStatus && nextStatus !== 'pending') {
      query.set('status', nextStatus);
    }
    if (nextPinned) query.set('pinned', nextPinned);
    if (nextDelivery) query.set('delivery', nextDelivery);
    const qs = query.toString();
    router.push(qs ? `/rules?${qs}` : '/rules');
  }

  const scopeItems = React.useMemo(
    () => ({
      [SCOPE_ALL]: labels.allScopes,
      ...Object.fromEntries(
        scopes.map((option) => [option.value, option.label])
      ),
    }),
    [scopes, labels.allScopes]
  );
  const statusItems = React.useMemo(
    () =>
      Object.fromEntries(
        statuses.map((option) => [option.value, option.label])
      ),
    [statuses]
  );

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="rules-filter"
    >
      {/* Scope: clears to "all scopes". */}
      <Select
        value={scope || SCOPE_ALL}
        items={scopeItems}
        onValueChange={(next) =>
          apply({ scope: next === SCOPE_ALL ? '' : String(next) })
        }
      >
        <SelectTrigger
          size="sm"
          className="min-w-40 max-w-56 [&>span]:truncate"
          data-testid="rules-filter-scope"
        >
          <SelectValue placeholder={labels.allScopes} />
        </SelectTrigger>
        <SelectContent className="w-max min-w-(--anchor-width) max-w-[32rem]">
          <SelectItem value={SCOPE_ALL}>{labels.allScopes}</SelectItem>
          {scopes.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="block w-full truncate" title={option.value}>
                {option.label}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Status: a real select — "all statuses" is an explicit option, so the
          filter is always resettable. */}
      <Select
        value={status}
        items={statusItems}
        onValueChange={(next) => apply({ status: String(next) })}
      >
        <SelectTrigger
          size="sm"
          className="min-w-36 [&>span]:truncate"
          data-testid="rules-filter-status"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="w-max min-w-(--anchor-width) max-w-[32rem]">
          {statuses.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="block w-full">{option.label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <FacetSelect
        value={pinned}
        placeholder={labels.pinnedAny}
        options={pinnedOptions}
        testId="rules-filter-pinned"
        onChange={(next) => apply({ pinned: next })}
      />

      {/* What a session actually receives: the same rule as delivery. */}
      <FacetSelect
        value={delivery}
        placeholder={labels.deliveryAny}
        options={deliveryOptions}
        testId="rules-filter-delivery"
        onChange={(next) => apply({ delivery: next })}
      />
    </div>
  );
}
