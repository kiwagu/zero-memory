'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * Sets or clears one parameter of the address and keeps the others, then
 * asks the server for the page again: the board's controls all live in the
 * URL, so a view can be linked and survives a reload.
 */
export function useSearchParamSetter(): (
  key: string,
  value: string | null
) => void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (key, value) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    const next = params.toString();
    router.push(next ? `${pathname}?${next}` : pathname);
    router.refresh();
  };
}
