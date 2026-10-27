'use client';

import { SearchForm } from '@workspace/ui/components/common/search-form';

import { useSearchParamSetter } from '@/components/use-search-param.client';

/**
 * Which cards of the board are on screen: a label (`ZM-42`, `#42`, `42`) or a
 * piece of a title. The query lives in the address beside the chosen board, so
 * a narrowed board can be linked and survives a reload; an empty query clears
 * it and shows the whole board again.
 */
export function BoardSearch({
  value,
  placeholder,
  submitLabel,
}: {
  value: string;
  placeholder: string;
  submitLabel: string;
}) {
  const setParam = useSearchParamSetter();

  return (
    <SearchForm
      // Keyed by the query in the address, so the field follows a reload or a
      // back step instead of keeping what was typed before it.
      key={value}
      testId="board-search"
      placeholder={placeholder}
      submitLabel={submitLabel}
      defaultValue={value}
      onSearch={(query) => setParam('q', query || null)}
    />
  );
}
