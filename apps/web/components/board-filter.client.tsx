'use client';

import {
  FacetSelect,
  type FacetOption,
} from '@workspace/ui/components/common/facet-select';

import { useSearchParamSetter } from '@/components/use-search-param.client';

/**
 * Which board is on screen.
 *
 * The DEFAULT — the board with the most recent activity — is the placeholder
 * row, so it never appears in the address: a bare `/board` keeps meaning "show
 * me where the work is moving", and picking that row again clears whatever
 * choice was made. Every other selection is explicit and lands in the URL, so
 * a board a reader is watching can be linked and reloaded.
 */
export function BoardFilter({
  options,
  placeholder,
  value,
  testId,
}: {
  options: FacetOption[];
  placeholder: string;
  value: string;
  testId?: string;
}) {
  const setParam = useSearchParamSetter();

  return (
    <FacetSelect
      value={value}
      placeholder={placeholder}
      options={options}
      testId={testId}
      // As wide as the board's own name, never wider: a truncated scope reads
      // as nothing at all, and a full-width control eats the title's row.
      width="content"
      onChange={(next) => setParam('scope', next || null)}
    />
  );
}
