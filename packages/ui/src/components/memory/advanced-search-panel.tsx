'use client';

import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select';
import { Textarea } from '@workspace/ui/components/textarea';
import { cn } from '@workspace/ui/lib/utils';

/**
 * AdvancedSearchPanel — the ranked (semantic) search input for the memory
 * feed. Pure mechanism: labels and option lists arrive translated, submission
 * and the language guess are injected. A toggle button expands a multiline
 * query field with its controls beside it; Enter submits, Shift+Enter breaks
 * the line. Submission is explicit by design — every query costs a
 * server-side embedding, so there is no search-as-you-type.
 */

interface AdvancedSearchOption {
  value: string;
  label: string;
}

interface AdvancedSearchLabels {
  toggle: string;
  placeholder: string;
  submit: string;
  allScopes: string;
  topK: string;
  clear: string;
}

interface AdvancedSearchValues {
  query: string;
  kinds: string[];
  scope: string;
  k: number;
}

interface AdvancedSearchPanelProps {
  labels: AdvancedSearchLabels;
  kinds: AdvancedSearchOption[];
  scopes: AdvancedSearchOption[];
  topKOptions: number[];
  values: AdvancedSearchValues;
  open: boolean;
  /** True when a ranked search is active (shows the clear affordance). */
  active: boolean;
  onToggle: () => void;
  onSubmit: (values: AdvancedSearchValues) => void;
  onClear: () => void;
}

const SCOPE_CLEAR = '__all__';

function AdvancedSearchPanel({
  labels,
  kinds,
  scopes,
  topKOptions,
  values,
  open,
  active,
  onToggle,
  onSubmit,
  onClear,
}: AdvancedSearchPanelProps) {
  const [query, setQuery] = React.useState(values.query);
  const [selectedKinds, setSelectedKinds] = React.useState(values.kinds);
  const [scope, setScope] = React.useState(values.scope);
  const [k, setK] = React.useState(values.k);

  const submit = () => {
    if (query.trim()) {
      onSubmit({ query: query.trim(), kinds: selectedKinds, scope, k });
    }
  };

  const toggleKind = (value: string) => {
    setSelectedKinds((current) =>
      current.includes(value)
        ? current.filter((kind) => kind !== value)
        : [...current, value]
    );
  };

  // Base UI's Select.Value renders the raw value unless the Root gets an
  // items map (value → label) to resolve the display text from.
  const scopeItems = React.useMemo(
    () => ({
      [SCOPE_CLEAR]: labels.allScopes,
      ...Object.fromEntries(
        scopes.map((option) => [option.value, option.label])
      ),
    }),
    [scopes, labels.allScopes]
  );

  return (
    <div className="w-full space-y-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="advanced-search-toggle"
        onClick={onToggle}
        className="text-muted-foreground"
      >
        <Search className="size-3.5" aria-hidden />
        {labels.toggle}
        {open ? (
          <ChevronUp className="size-3.5" aria-hidden />
        ) : (
          <ChevronDown className="size-3.5" aria-hidden />
        )}
      </Button>
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="flex flex-wrap gap-3 rounded-xl border bg-card p-3 sm:flex-nowrap"
        >
          <Textarea
            name="query"
            data-testid="advanced-search-query"
            value={query}
            placeholder={labels.placeholder}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            className="min-h-24 flex-1 basis-full sm:basis-auto"
          />
          <div className="flex min-w-44 flex-col gap-2">
            <div className="flex flex-wrap gap-1">
              {kinds.map((option) => {
                const selected = selectedKinds.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    data-testid="advanced-search-kind-chip"
                    data-selected={selected || undefined}
                    onClick={() => toggleKind(option.value)}
                    className="cursor-pointer"
                  >
                    <Badge
                      variant={selected ? 'blue' : 'outline'}
                      className={cn(!selected && 'text-muted-foreground')}
                    >
                      {option.label}
                    </Badge>
                  </button>
                );
              })}
            </div>
            {scopes.length > 0 ? (
              <Select
                value={scope || SCOPE_CLEAR}
                items={scopeItems}
                onValueChange={(next) =>
                  setScope(next === SCOPE_CLEAR ? '' : String(next))
                }
              >
                <SelectTrigger
                  size="sm"
                  data-testid="advanced-search-scope"
                  className="max-w-56 [&>span]:truncate"
                >
                  <SelectValue placeholder={labels.allScopes} />
                </SelectTrigger>
                <SelectContent className="w-max min-w-(--anchor-width) max-w-[28rem]">
                  <SelectItem value={SCOPE_CLEAR}>
                    {labels.allScopes}
                  </SelectItem>
                  {scopes.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <span
                        className="block max-w-[26rem] truncate"
                        title={option.value}
                      >
                        {option.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <div className="flex items-center gap-2">
              <Select
                value={String(k)}
                onValueChange={(next) => setK(Number(next))}
              >
                <SelectTrigger
                  size="sm"
                  className="min-w-20"
                  data-testid="advanced-search-top-k"
                >
                  <SelectValue placeholder={labels.topK} />
                </SelectTrigger>
                <SelectContent>
                  {topKOptions.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {`${labels.topK}: ${option}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                size="sm"
                data-testid="advanced-search-submit"
                disabled={!query.trim()}
              >
                {labels.submit}
              </Button>
              {active ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="advanced-search-clear"
                  onClick={onClear}
                >
                  {labels.clear}
                </Button>
              ) : null}
            </div>
          </div>
        </form>
      ) : null}
    </div>
  );
}

export {
  AdvancedSearchPanel,
  type AdvancedSearchLabels,
  type AdvancedSearchOption,
  type AdvancedSearchPanelProps,
  type AdvancedSearchValues,
};
