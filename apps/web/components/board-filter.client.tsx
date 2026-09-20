'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import {
  FacetSelect,
  type FacetOption,
} from '@workspace/ui/components/common/facet-select';

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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <FacetSelect
      value={value}
      placeholder={placeholder}
      options={options}
      testId={testId}
      // As wide as the board's own name, never wider: a truncated scope reads
      // as nothing at all, and a full-width control eats the title's row.
      width="content"
      onChange={(next) => {
        const params = new URLSearchParams(searchParams.toString());
        if (next) {
          params.set('scope', next);
        } else {
          params.delete('scope');
        }
        const query = params.toString();
        router.push(query ? `${pathname}?${query}` : pathname);
        router.refresh();
      }}
    />
  );
}
