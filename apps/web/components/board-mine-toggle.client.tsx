'use client';

import { Switch } from '@workspace/ui/components/switch';

import { useSearchParamSetter } from '@/components/use-search-param.client';

/**
 * Switches the board between its columns and the cards I worked on. The
 * choice lives in the address (`?mine=1`) beside the board and the filter.
 */
export function BoardMineToggle({
  checked,
  label,
}: {
  checked: boolean;
  label: string;
}) {
  const setParam = useSearchParamSetter();
  return (
    <label className="flex items-center gap-2 text-sm">
      {label}
      <Switch
        size="sm"
        data-testid="board-mine-toggle"
        checked={checked}
        onCheckedChange={(next) => setParam('mine', next ? '1' : null)}
      />
    </label>
  );
}
