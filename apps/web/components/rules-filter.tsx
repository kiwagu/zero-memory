'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

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
 * disappearing default.
 */
export function RulesFilter({
  scope,
  status,
  scopes,
  statuses,
  labels,
}: {
  scope: string;
  /** One of the status values (incl. the explicit "all" option). */
  status: string;
  scopes: RulesFilterOption[];
  statuses: RulesFilterOption[];
  labels: { allScopes: string };
}) {
  const router = useRouter();

  function apply(next: { scope?: string; status?: string }) {
    const query = new URLSearchParams();
    const nextScope = next.scope ?? scope;
    const nextStatus = next.status ?? status;
    if (nextScope) query.set('scope', nextScope);
    // `pending` is the default queue → omit it from the URL for a clean path.
    if (nextStatus && nextStatus !== 'pending') {
      query.set('status', nextStatus);
    }
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
    </div>
  );
}
